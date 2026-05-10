import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders, characters } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
// galleryImages 结构: { user: [url1, url2...], chars: { 'charName': [url1...] } }
if (!extension_settings.avatarGallery) extension_settings.avatarGallery = { user: [], chars: {} };
// themeBinds 结构: { 'themeName': { 'user': url, 'charName': url } }
if (!extension_settings.themeBinds) extension_settings.themeBinds = {};

// ======================== 核心辅助函数 ========================

// 从src解析出当前头像的身份 (User 或 Char)
function parseAvatarSrc(src) {
    if (!src) return null;
    let cleanSrc = src.split('?')[0];
    const isUser = cleanSrc.includes('User Avatars') || cleanSrc.includes('thumbnails/persona');
    
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        let id = fileParam ? decodeURIComponent(fileParam) : decodeURIComponent(urlObj.pathname.split('/').pop());
        return { type: isUser ? 'user' : 'char', id: isUser ? 'user' : id };
    } catch (e) {
        let id = decodeURIComponent(cleanSrc.split('/').pop());
        return { type: isUser ? 'user' : 'char', id: isUser ? 'user' : id };
    }
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

// 调用原生API保存Base64为实体文件，并返回相对路径
async function saveToBackend(base64Str, fileName) {
    try {
        let base64Data = base64Str;
        if (base64Str.includes(',')) base64Data = base64Str.split(',')[1];

        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                image: base64Data,
                format: 'png',
                ch_name: 'Extension_AvatarGallery',
                filename: fileName.replace(/\./g, '_') + '_' + Date.now()
            })
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; // 返回相对路径 e.g., user/images/...
        }
    } catch (error) {
        console.error('Failed to save image to backend:', error);
    }
    return null;
}

// 调用原生API删除文件
async function deleteFromBackend(url) {
    if (!url || url.startsWith('data:')) return;
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: url })
        });
    } catch (e) { }
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    const data = await fetch(url);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => resolve(reader.result);
    });
}

// 压缩上传的图片以供图库使用
async function resizeImageToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 1000;
                let width = img.width, height = img.height;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width; width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height; height = MAX_SIZE;
                }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ======================== 全局真·替换核心 (调用ST原生API) ========================
async function triggerNativeUpload(imgUrl, avatarInfo) {
    try {
        // 1. 获取图库里那张新图的真实文件流
        const response = await fetch(imgUrl);
        const blob = await response.blob();
        const file = new File([blob], avatarInfo.id, { type: blob.type });

        // 2. 准备请求头，必须删除 Content-Type，让 fetch 自动生成 multipart/form-data 的 boundary
        const headers = Object.assign({}, getRequestHeaders());
        delete headers['Content-Type'];

        if (avatarInfo.type === 'user') {
            // ---- 替换用户(User/Persona)头像 ----
            const formData = new FormData();
            formData.append('avatar', file);
            formData.append('overwrite_name', avatarInfo.id);

            const res = await fetch('/api/avatars/upload', {
                method: 'POST',
                headers: headers,
                body: formData
            });

            if (res.ok) {
                toastr.success('用户头像全局替换成功！');
                flushImageCache(avatarInfo.id);
            } else {
                toastr.error('用户头像替换失败');
            }

        } else {
            // ---- 替换角色(Char)头像 ----
            const charIndex = characters.findIndex(c => c.avatar === avatarInfo.id);
            if (charIndex === -1) return toastr.error('找不到对应角色数据');
            
            const charData = characters[charIndex];
            const formData = new FormData();
            
            // 将角色的所有现有设定一并提交，确保导出的新卡片包含全部数据
            formData.append('avatar', file);
            formData.append('ch_name', charData.name);
            formData.append('description', charData.description || '');
            formData.append('personality', charData.personality || '');
            formData.append('first_mes', charData.first_mes || '');
            formData.append('mes_example', charData.mes_example || '');
            formData.append('scenario', charData.scenario || '');
            formData.append('creator_notes', charData.creator_notes || '');
            formData.append('system_prompt', charData.system_prompt || '');
            formData.append('post_history_instructions', charData.post_history_instructions || '');
            formData.append('tags', charData.tags ? charData.tags.join(',') : '');
            formData.append('creator', charData.creator || '');
            formData.append('character_version', charData.character_version || '');
            formData.append('alternate_greetings', JSON.stringify(charData.alternate_greetings || []));
            formData.append('extensions', JSON.stringify(charData.extensions || {}));
            // 最重要的一步：告诉ST我们要覆盖哪个原图
            formData.append('original_avatar', charData.avatar);

            const res = await fetch('/api/characters/edit', {
                method: 'POST',
                headers: headers,
                body: formData
            });

            if (res.ok) {
                toastr.success('角色头像全局替换成功！导出的卡面已更新。');
                flushImageCache(avatarInfo.id);
            } else {
                toastr.error('角色头像替换失败');
            }
        }
    } catch (e) {
        console.error("Native upload trigger failed:", e);
        toastr.error("触发全局替换失败，请查看控制台。");
    }
}

// 强制刷新所有带有该头像的 img 标签以破解浏览器缓存
function flushImageCache(avatarId) {
    const escapedId = avatarId.replace(/"/g, '\\"');
    const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
    document.querySelectorAll(`img[src*="${escapedId}"], img[src*="${encodedId}"]`).forEach(img => {
        let cleanSrc = img.src.split('?')[0];
        img.src = cleanSrc + '?t=' + Date.now();
    });
}

// ======================== CSS 局部绑定引擎 ========================

function applyThemeBinds() {
    const theme = getCurrentTheme();
    const currentBinds = extension_settings.themeBinds[theme] || {};
    let cssString = '';

    for (const [id, url] of Object.entries(currentBinds)) {
        if (!url) continue;
        const escapedId = id.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(id).replace(/"/g, '\\"');
        
        // 【核心】只覆盖聊天气泡 (.mes) 内的头像
        let selector = '';
        if (id === 'user') {
            selector = `#chat .mes[is_user="true"] .avatar img`;
        } else {
            selector = `#chat .mes .avatar img[src*="${escapedId}"], #chat .mes .avatar img[src*="${encodedId}"]`;
        }

        cssString += `
            ${selector} {
                content: url("${url}") !important;
                object-fit: cover !important;
            }
        `;
    }

    let styleTag = document.getElementById('st-avatar-crop-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-avatar-crop-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// ======================== UI 注入面板 ========================

function injectControlButtons(zoomedDiv) {
    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar || controlBar.querySelector('#st-gallery-btn')) return;

    const img = zoomedDiv.querySelector('img');
    const avatarInfo = parseAvatarSrc(img.src);
    if (!avatarInfo) return;

    const theme = getCurrentTheme();
    const binds = extension_settings.themeBinds[theme] || {};
    const isBound = !!binds[avatarInfo.id];

    // 1. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'st-avatar-ctrl-btn';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = '打开独立图库';
    galleryBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); openGallery(avatarInfo); };

    // 2. 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'st-avatar-ctrl-btn';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '剪裁图片并覆盖至当前聊天';
    cropBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); triggerCropPopup(img.src, avatarInfo); };

    // 3. 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = `st-avatar-ctrl-btn ${isBound ? 'is-bound' : ''}`;
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = isBound ? '已绑定在当前主题 (点击解除绑定并恢复默认)' : '当前未绑定在美化主题';
    bindBtn.onclick = async (e) => {
        e.stopPropagation();
        toggleBind(avatarInfo.id, img.src, bindBtn);
    };

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(bindBtn, closeBtn);
        controlBar.insertBefore(cropBtn, bindBtn);
        controlBar.insertBefore(galleryBtn, cropBtn);
    }
}

// ======================== 功能逻辑 ========================

// 绑定/解绑逻辑
async function toggleBind(targetId, currentImgSrc, btnElement) {
    const theme = getCurrentTheme();
    if (!extension_settings.themeBinds[theme]) extension_settings.themeBinds[theme] = {};
    
    const isBound = !!extension_settings.themeBinds[theme][targetId];

    if (isBound) {
        // 解除绑定
        delete extension_settings.themeBinds[theme][targetId];
        btnElement.classList.remove('is-bound');
        btnElement.title = '当前未绑定在美化主题';
        toastr.info('已解除该角色/用户在此主题下的头像绑定，恢复默认。');
    } else {
        // 绑定图片
        const base64 = await getBase64FromUrl(currentImgSrc);
        const savedUrl = await saveToBackend(base64, `bind_${targetId}`);
        extension_settings.themeBinds[theme][targetId] = savedUrl || currentImgSrc;
        btnElement.classList.add('is-bound');
        btnElement.title = '已绑定在当前主题 (点击解除绑定并恢复默认)';
        toastr.success('当前图片已绑定至此主题的聊天气泡中！');
    }
    
    saveSettingsDebounced();
    applyThemeBinds();
}

// 原生剪裁逻辑
async function triggerCropPopup(imgSrc, avatarInfo) {
    const base64Original = await getBase64FromUrl(imgSrc);
    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: base64Original });

    setTimeout(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            cropperImg.cropper.setDragMode('move');
            cropperImg.cropper.options.wheelZoomRatio = 0.05;
        }
    }, 150);

    const croppedImageBase64 = await cropPromise;
    if (croppedImageBase64) {
        const savedUrl = await saveToBackend(croppedImageBase64, `crop_${avatarInfo.id}`);
        if (!savedUrl) return toastr.error("保存剪裁图片失败");

        // 自动激活绑定到当前主题
        const theme = getCurrentTheme();
        if (!extension_settings.themeBinds[theme]) extension_settings.themeBinds[theme] = {};
        extension_settings.themeBinds[theme][avatarInfo.id] = savedUrl;
        
        saveSettingsDebounced();
        applyThemeBinds();
        toastr.success('已剪裁并自动绑定到当前主题下的聊天气泡中！');
    }
}

// 独立图库逻辑
async function openGallery(avatarInfo) {
    const id = avatarInfo.id;
    let images = [];
    if (avatarInfo.type === 'user') {
        images = extension_settings.avatarGallery.user;
    } else {
        if (!extension_settings.avatarGallery.chars[id]) extension_settings.avatarGallery.chars[id] = [];
        images = extension_settings.avatarGallery.chars[id];
    }

    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${avatarInfo.type === 'user' ? '用户' : '角色'}专属图库</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理列表"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-delete-confirm" title="确认删除 (0)" style="display:none; color:#ff4444;"><i class="fa-solid fa-trash-can"></i></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    let selectedUrl = null;

    callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true }).then((confirm) => {
        if (confirm && selectedUrl) {
            // 用户点击了OK，触发全局真·替换
            triggerNativeUpload(selectedUrl, avatarInfo);
        }
    });

    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if (!grid) return;

        let isDeleteMode = false;
        let itemsToDelete = new Set();

        function renderGrid() {
            grid.innerHTML = '';
            images.forEach((url, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (selectedUrl === url ? ' selected' : '');
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${url}">`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) {
                        e.stopPropagation();
                        itemsToDelete.has(index) ? itemsToDelete.delete(index) : itemsToDelete.add(index);
                        document.getElementById('btn-alt-delete-confirm').title = `确认删除 (${itemsToDelete.size})`;
                        renderGrid();
                    } else {
                        selectedUrl = url;
                        renderGrid();
                    }
                };
                grid.appendChild(itemDiv);
            });
        }

        document.getElementById('btn-alt-upload').onclick = () => document.getElementById('input-alt-upload').click();
        
        document.getElementById('input-alt-upload').onchange = async (e) => {
            const files = e.target.files;
            if (!files.length) return;
            toastr.info(`正在上传并处理 ${files.length} 张图片...`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const savedUrl = await saveToBackend(b64, `gallery_${id}`);
                if (savedUrl) images.push(savedUrl);
            }
            saveSettingsDebounced();
            renderGrid();
        };

        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');

        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            btnManage.innerHTML = isDeleteMode ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-trash-can"></i>';
            document.getElementById('btn-alt-upload').style.display = isDeleteMode ? 'none' : 'flex';
            btnDeleteConfirm.style.display = isDeleteMode ? 'flex' : 'none';
            itemsToDelete.clear();
            btnDeleteConfirm.title = `确认删除 (0)`;
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            
            indexes.forEach((index) => {
                const urlToDelete = images[index];
                images.splice(index, 1);
                deleteFromBackend(urlToDelete); 

                // 清理可能遗留的绑定数据
                for (const t of Object.keys(extension_settings.themeBinds)) {
                    if (extension_settings.themeBinds[t][id] === urlToDelete) {
                        delete extension_settings.themeBinds[t][id];
                    }
                }
            });

            saveSettingsDebounced();
            applyThemeBinds();
            btnManage.click();
            toastr.success('已删除选中图片并清理绑定记录');
        };

        renderGrid();
    }, 100);
}

// ======================== 主进程监控 ========================

let lastTheme = getCurrentTheme();
let lastChar = null;

setInterval(() => {
    const currentTheme = getCurrentTheme();
    const currentCharObj = document.querySelector('.mes_ch_name');
    const currentChar = currentCharObj ? currentCharObj.innerText : null;

    if (currentTheme !== lastTheme || currentChar !== lastChar) {
        lastTheme = currentTheme;
        lastChar = currentChar;
        applyThemeBinds();
    }
}, 1000);

jQuery(async () => {
    applyThemeBinds();
    console.log('[Avatar & Gallery Controller] Successfully Loaded.');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectControlButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectControlButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
