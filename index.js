import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, characters, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化全新数据结构 (丢弃旧的Base64，使用实体文件链接)
if (!extension_settings.stAvatarEngine) {
    extension_settings.stAvatarEngine = {
        gallery: { globalUser: [], chars: {} },
        bindings: {}, // 格式: { themeName: { contextId: { type: 'crop'|'gallery', url: '...' } } }
        crops: {}     // 仅供.mes使用的裁剪图缓存
    };
}
const engineData = extension_settings.stAvatarEngine;

const GLOBAL_USER_ID = '__GLOBAL_USER__';

// ======================== 工具与核心机制 ========================

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

// 识别当前被放大的头像是User还是Char
function getContextFromImg(imgSrc) {
    if (!imgSrc) return { isUser: false, id: null };
    const decoded = decodeURIComponent(imgSrc);
    if (decoded.includes('User Avatars') || decoded.includes('User%20Avatars')) {
        return { isUser: true, id: GLOBAL_USER_ID };
    }
    return { isUser: false, id: getAvatarIdFromSrc(imgSrc) };
}

// 核心：把文件存为实体，存入 public/images/AvatarCropper/
async function saveImageToServerAsFile(blob, prefixName) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
            const base64Data = reader.result.split(',')[1];
            const format = blob.type.split('/')[1] || 'png';
            const filename = `${prefixName}_${Date.now()}`;

            try {
                const response = await fetch('/api/images/upload', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        image: base64Data,
                        format: format,
                        ch_name: 'AvatarCropper', // 这里充当文件夹名
                        filename: filename
                    })
                });
                if (response.ok) {
                    const data = await response.json();
                    resolve(data.path); // 返回真实链接，如 images/AvatarCropper/xxx.png
                } else {
                    resolve(null);
                }
            } catch (e) {
                console.error("上传实体图片失败", e);
                resolve(null);
            }
        };
    });
}

// 核心：调动ST原生上传替换，确保实体物理文件和卡片数据被安全更新 (可导出)
async function triggerNativeReplace(imageUrl, context) {
    try {
        const blob = await fetch(imageUrl).then(r => r.blob());
        
        if (context.isUser) {
            // User: 替换原生 Persona 头像
            const file = new File([blob], 'user_avatar.png', { type: blob.type });
            const formData = new FormData();
            formData.append('avatar', file);
            
            // 获取当前所选的 Persona 名字
            const previewImg = document.getElementById('avatar_load_preview');
            const currentUserFile = previewImg ? getAvatarIdFromSrc(previewImg.src) : 'User';
            formData.append('overwrite_name', currentUserFile);

            await fetch('/api/avatars/upload', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: formData
            });

            toastr.success('User原生头像已替换！');
            $(`.avatar img[src*="${currentUserFile}"]`).attr('src', `${imageUrl}?t=${Date.now()}`);
            $('#avatar_load_preview').attr('src', `${imageUrl}?t=${Date.now()}`);

        } else {
            // Char: 提取所有设定数据，与新图片合并后提交，保证不丢数据
            const charId = context.id;
            const char = characters.find(c => c.avatar === charId);
            if (!char) return;

            const file = new File([blob], char.avatar, { type: blob.type });
            const formData = new FormData();
            formData.append('avatar', file);
            formData.append('ch_name', char.name);
            
            // 附带全部必要的旧数据以防止被清空
            formData.append('description', char.description || '');
            formData.append('personality', char.personality || '');
            formData.append('first_mes', char.first_mes || '');
            formData.append('mes_example', char.mes_example || '');
            formData.append('scenario', char.scenario || '');
            formData.append('creator_notes', char.creatorcomment || '');
            formData.append('system_prompt', char.system_prompt || '');
            formData.append('post_history_instructions', char.post_history_instructions || '');
            formData.append('tags', (char.tags || []).join(','));
            formData.append('creator', char.creator || '');
            formData.append('character_version', char.character_version || '');
            if(char.alternate_greetings) formData.append('alternate_greetings', JSON.stringify(char.alternate_greetings));

            await fetch('/api/characters/edit', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: formData
            });

            toastr.success('Char卡面及原生文件已替换！(可安全导出)');
            $(`.avatar img[src*="${char.avatar}"]`).attr('src', `${imageUrl}?t=${Date.now()}`);
            $('#avatar_load_preview').attr('src', `${imageUrl}?t=${Date.now()}`);
        }
    } catch (e) {
        console.error("原生替换失败", e);
        toastr.error('执行原生替换失败');
    }
}

// 仅应用在 .mes 的裁剪 CSS 注入
function applyCropCSSToMes() {
    let cssString = '';
    const theme = getCurrentTheme();
    const currentBindings = engineData.bindings[theme] || {};

    for (const [contextId, bindObj] of Object.entries(currentBindings)) {
        if (bindObj.type === 'crop' && bindObj.url) {
            const safeId = contextId === GLOBAL_USER_ID ? 'User Avatars' : contextId.replace(/"/g, '\\"');
            cssString += `
                .mes .avatar img[src*="${safeId}"] {
                    content: url("${bindObj.url}") !important;
                    object-fit: cover !important;
                }
            `;
        }
    }

    let styleTag = document.getElementById('custom-avatar-crop-style-mes');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-crop-style-mes';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// 确保原始头像被保留为默认图
async function ensureOriginalInGallery(context, originalSrc) {
    if (!originalSrc || originalSrc.startsWith('data:') || originalSrc.startsWith('blob:')) return;
    
    let list = context.isUser ? engineData.gallery.globalUser : (engineData.gallery.chars[context.id] = engineData.gallery.chars[context.id] || []);
    
    if (list.length === 0) {
        // 作为列表的首张"默认初始图"
        list.push(originalSrc);
        saveSettingsDebounced();
    }
}

// 清理失效绑定的辅助函数
function cleanUpBindingsIfDeleted(deletedUrl) {
    for (const theme in engineData.bindings) {
        for (const contextId in engineData.bindings[theme]) {
            if (engineData.bindings[theme][contextId].url === deletedUrl) {
                delete engineData.bindings[theme][contextId];
            }
        }
    }
    saveSettingsDebounced();
}

// ======================== 图库面板系统 ========================

async function openGalleryPanel(context, currentActiveSrc) {
    await ensureOriginalInGallery(context, currentActiveSrc);

    let list = context.isUser ? engineData.gallery.globalUser : engineData.gallery.chars[context.id];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${context.isUser ? 'Global User' : 'Character'} 图库</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理图库"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-delete-confirm" title="确认删除 (0)" style="display:none; color:#ff4444;"><i class="fa-solid fa-trash-can"></i></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
    
    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');
        const inputUpload = document.getElementById('input-alt-upload');
        
        let isDeleteMode = false;
        let itemsToDelete = new Set();
        
        function renderGrid() {
            grid.innerHTML = '';
            list.forEach((url, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item';
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                // 简单的防缓存处理
                itemDiv.innerHTML = `<img src="${url}?t=${Date.now()}" onerror="this.src='img/ai4.png'">`;
                
                itemDiv.onclick = async (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        if (itemsToDelete.has(index)) {
                            itemsToDelete.delete(index);
                            itemDiv.classList.remove('to-delete');
                        } else {
                            itemsToDelete.add(index);
                            itemDiv.classList.add('to-delete');
                        }
                        btnDeleteConfirm.title = `确认删除 (${itemsToDelete.size})`;
                    } else { 
                        // 点击图片：触发真正的原生物理替换
                        document.querySelector('#dialogue_popup .popup-controls .fa-xmark')?.click(); // 关掉弹窗
                        await triggerNativeReplace(url, context);
                    }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            btnManage.innerHTML = isDeleteMode ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-trash-can"></i>';
            btnUpload.style.display = isDeleteMode ? 'none' : 'flex';
            btnDeleteConfirm.style.display = isDeleteMode ? 'flex' : 'none';
            itemsToDelete.clear();
            btnDeleteConfirm.title = `确认删除 (0)`;
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();

            const confirm = await callGenericPopup(`确认彻底删除选中的 ${itemsToDelete.size} 张图片？（相关绑定也会清空）`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            indexes.forEach((index) => {
                const deletedUrl = list[index];
                cleanUpBindingsIfDeleted(deletedUrl);
                list.splice(index, 1);
            });

            // 如果全部删光了，恢复SillyTavern初始默认头像
            if (list.length === 0) {
                const defaultFallback = context.isUser ? 'img/ai4.png' : 'img/ai4.png';
                await triggerNativeReplace(defaultFallback, context);
                toastr.warning('图库已清空，恢复系统默认头像');
            }

            saveSettingsDebounced();
            applyCropCSSToMes(); // 刷新绑定UI
            btnManage.click(); 
            toastr.success('已删除');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在上传 ${files.length} 张图片到服务器...`);
            for(let i = 0; i < files.length; i++) {
                const prefix = context.isUser ? 'UserGal' : 'CharGal';
                const serverUrl = await saveImageToServerAsFile(files[i], prefix);
                if (serverUrl) list.push(serverUrl);
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('上传完成');
        };
        
        renderGrid();
    }, 100);
}

// ======================== 控制面板按钮注入 ========================

async function triggerCropSequence(context, imgSrc) {
    const blobOriginal = await fetch(imgSrc).then(r => r.blob());
    const base64Original = await new Promise(res => {
        const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blobOriginal);
    });

    const croppedImageBase64 = await callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    if (croppedImageBase64) {
        const croppedBlob = await fetch(croppedImageBase64).then(r => r.blob());
        const serverUrl = await saveImageToServerAsFile(croppedBlob, context.isUser ? 'UserCrop' : 'CharCrop');
        
        if (serverUrl) {
            // 裁剪后：自动保存并在当前主题激活绑定！
            const theme = getCurrentTheme();
            if(!engineData.bindings[theme]) engineData.bindings[theme] = {};
            
            engineData.bindings[theme][context.id] = { type: 'crop', url: serverUrl };
            saveSettingsDebounced();
            applyCropCSSToMes();
            toastr.success('裁剪已保存，且仅对 .mes 对话区域生效并已绑定当前主题！');
            
            // 刷新当前面板绑定按钮颜色
            const bindBtn = document.getElementById('st-bind-btn');
            if (bindBtn) bindBtn.classList.add('st-bind-active');
        }
    }
}

function injectZoomPanelButtons(zoomedDiv) {
    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar || controlBar.querySelector('#st-gallery-btn')) return;

    const img = zoomedDiv.querySelector('img');
    const context = getContextFromImg(img?.src);

    // 1. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'menu_button menu_button_icon';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = '打开实体图库 (原图/切图)';
    galleryBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); openGalleryPanel(context, img.src); };

    // 2. 裁剪按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'menu_button menu_button_icon';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '裁剪头像 (仅用于.mes显示)';
    cropBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); triggerCropSequence(context, img.src); };

    // 3. 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = 'menu_button menu_button_icon';
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = '将当前状态绑定至当前美化主题';
    
    // 初始化绑定按钮颜色
    const theme = getCurrentTheme();
    const isBound = engineData.bindings[theme] && engineData.bindings[theme][context.id];
    if (isBound) bindBtn.classList.add('st-bind-active');

    bindBtn.onclick = async (e) => {
        e.stopPropagation();
        if(!engineData.bindings[theme]) engineData.bindings[theme] = {};
        
        if (bindBtn.classList.contains('st-bind-active')) {
            // 解除绑定，恢复默认
            delete engineData.bindings[theme][context.id];
            bindBtn.classList.remove('st-bind-active');
            saveSettingsDebounced();
            applyCropCSSToMes(); // 取消CSS裁剪
            
            // 恢复原生图
            const list = context.isUser ? engineData.gallery.globalUser : engineData.gallery.chars[context.id];
            if(list && list.length > 0) await triggerNativeReplace(list[0], context); // list[0]是保存的默认初始图
            
            toastr.info('已解除绑定，恢复默认状态');
        } else {
            // 添加绑定为图库实体(当前img.src)
            engineData.bindings[theme][context.id] = { type: 'gallery', url: img.src };
            bindBtn.classList.add('st-bind-active');
            saveSettingsDebounced();
            toastr.success('已将当前头像绑定至本主题！');
        }
    };

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(galleryBtn, closeBtn);
        controlBar.insertBefore(cropBtn, closeBtn);
        controlBar.insertBefore(bindBtn, closeBtn);
    } else {
        controlBar.appendChild(galleryBtn);
        controlBar.appendChild(cropBtn);
        controlBar.appendChild(bindBtn);
    }
}

// ======================== 主题切换 & 全局监控 ========================

let lastTheme = getCurrentTheme();

setInterval(async () => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCropCSSToMes(); // 立刻应用CSS裁剪绑定

        // 处理物理 Gallery 的绑定切换
        const bindings = engineData.bindings[currentTheme] || {};
        
        // 我们只检查当前界面的角色和User，防止不必要的全局替换开销
        const previewImg = document.getElementById('avatar_load_preview');
        const activeCharId = previewImg ? getAvatarIdFromSrc(previewImg.src) : null;
        
        // 处理Char
        if (activeCharId) {
            const charBind = bindings[activeCharId];
            const context = { isUser: false, id: activeCharId };
            
            if (charBind && charBind.type === 'gallery') {
                await triggerNativeReplace(charBind.url, context);
            } else if (!charBind) {
                // 如果当前主题没绑定，恢复默认
                const list = engineData.gallery.chars[activeCharId];
                if (list && list.length > 0) await triggerNativeReplace(list[0], context);
            }
        }

        // 处理User
        const userBind = bindings[GLOBAL_USER_ID];
        const userContext = { isUser: true, id: GLOBAL_USER_ID };
        if (userBind && userBind.type === 'gallery') {
            await triggerNativeReplace(userBind.url, userContext);
        } else if (!userBind) {
            const uList = engineData.gallery.globalUser;
            if (uList && uList.length > 0) await triggerNativeReplace(uList[0], userContext);
        }
    }
}, 1000);

// 初始化运行
jQuery(async () => {
    applyCropCSSToMes();
    console.log('[AvatarEngine] Entity File Engine Successfully Loaded.');

    // 监控放出大头像的面板生成
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectZoomPanelButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectZoomPanelButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
