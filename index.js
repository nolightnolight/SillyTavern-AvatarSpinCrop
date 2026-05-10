import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化全新数据结构
if (extension_settings.avatarClickZoomEnabled === undefined) extension_settings.avatarClickZoomEnabled = false;
if (!extension_settings.st_gallery) extension_settings.st_gallery = { user: [], chars: {} };
if (!extension_settings.st_bindings) extension_settings.st_bindings = {};

function getAvatarIdFromSrc(src) {
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        if (fileParam) return decodeURIComponent(fileParam);
        
        const parts = urlObj.pathname.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    }
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function getCsrfToken() {
    return document.head.querySelector('meta[name="csrf-token"]')?.content || window['csrf_token'] || '';
}

// 识别当前放大头像的是User还是Char，并返回唯一标识符
function getZoomedContext(imgSrc) {
    const isUser = imgSrc.includes('User%20Avatars') || imgSrc.includes('User Avatars') || imgSrc.includes('user_avatar');
    let identifier = isUser ? 'user' : getAvatarIdFromSrc(imgSrc);
    return { isUser, identifier };
}

// ======================== 后端文件交互引擎 ========================

// 将Base64转换为实体文件保存在ST后端的 user/images/AvatarsGallery 文件夹中，告别JSON膨胀
async function saveImageToBackend(base64) {
    try {
        const req = {
            image: base64.split(',')[1] || base64,
            format: 'png',
            ch_name: 'AvatarsGallery',
            filename: `avatar_${Date.now()}_${Math.floor(Math.random() * 1000)}`
        };
        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify(req)
        });
        if (res.ok) {
            const data = await res.json();
            return data.path; // 返回相对路径
        }
    } catch (e) {
        console.error("保存图片到后端失败:", e);
    }
    return base64; // 失败则回退到base64
}

// 将路径或Base64打包成原生File并注入ST原生的上传按钮，触发ST的原生替换逻辑（实现导出更新及全局更新）
async function triggerNativeUpload(isUser, imagePathOrBase64) {
    try {
        const res = await fetch(imagePathOrBase64);
        const blob = await res.blob();
        const file = new File([blob], `gallery_swap_${Date.now()}.png`, { type: 'image/png' });
        
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        let inputId = isUser ? 'avatar_upload_file' : 'character_replace_file';
        const fileInput = document.getElementById(inputId);
        
        if (fileInput) {
            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            toastr.success('已触发原生头像更新');
        } else {
            toastr.error('未找到原生上传接口');
        }
    } catch (e) {
        console.error("触发原生上传失败:", e);
        toastr.error('切换原生头像失败');
    }
}

async function resizeImageToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 800; 
                let width = img.width;
                let height = img.height;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png')); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ======================== 主题绑定引擎（仅对聊天区域生效） ========================

function applyThemeBindings() {
    const theme = getCurrentTheme();
    const bindings = extension_settings.st_bindings[theme] || {};
    let cssString = '';
    
    for (const [identifier, imagePath] of Object.entries(bindings)) {
        if (!imagePath) continue;
        
        if (identifier === 'user') {
            cssString += `
                #chat .mes[is_user="true"] .avatar img {
                    content: url("${imagePath}") !important;
                    object-fit: cover !important;
                }
            `;
        } else {
            const escapedId = identifier.replace(/"/g, '\\"');
            const encodedId = encodeURIComponent(identifier).replace(/"/g, '\\"');
            cssString += `
                #chat .mes[is_user="false"] .avatar img[src*="${escapedId}"],
                #chat .mes[is_user="false"] .avatar img[src*="${encodedId}"] {
                    content: url("${imagePath}") !important;
                    object-fit: cover !important;
                }
            `;
        }
    }

    let styleTag = document.getElementById('st-theme-bindings-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-theme-bindings-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// ======================== 独立的图库面板 ========================

async function openGalleryPanel(isUser, identifier, originalSrc, bindBtnEl) {
    // 确保数据结构存在
    if (!isUser && !extension_settings.st_gallery.chars[identifier]) {
        extension_settings.st_gallery.chars[identifier] = [];
    }
    
    const imageList = isUser ? extension_settings.st_gallery.user : extension_settings.st_gallery.chars[identifier];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? 'User 独立图库' : 'Char 独立图库'}</h3>
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
            
            // 当前原生原图
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item';
            origDiv.innerHTML = `<img src="${originalSrc}" title="当前原生头像">`;
            origDiv.onclick = () => { if(!isDeleteMode) toastr.info('这已经是当前显示的图片'); };
            grid.appendChild(origDiv);
            
            imageList.forEach((imgPath, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item';
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${imgPath}">`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        if (itemsToDelete.has(index)) itemsToDelete.delete(index);
                        else itemsToDelete.add(index);
                        btnDeleteConfirm.title = `确认删除 (${itemsToDelete.size})`;
                        renderGrid();
                    } else { 
                        // 点击切换：触发原生上传
                        triggerNativeUpload(isUser, imgPath);
                        document.querySelector('.popup-controls .popup-close')?.click();
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
            const confirm = await callGenericPopup(`是否确认删除选中的 ${itemsToDelete.size} 张图片？相关绑定数据也会一并清除。`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            const pathsToDelete = indexes.map(i => imageList[i]);
            
            indexes.forEach((index) => imageList.splice(index, 1));

            // 清除全局绑定数据中与该图片匹配的项
            for (const t in extension_settings.st_bindings) {
                for (const id in extension_settings.st_bindings[t]) {
                    if (pathsToDelete.includes(extension_settings.st_bindings[t][id])) {
                        delete extension_settings.st_bindings[t][id];
                    }
                }
            }

            saveSettingsDebounced();
            applyThemeBindings();
            
            btnManage.click(); 
            toastr.success('已成功删除并清空相关绑定');
            
            // 如果删除了所有的图，提示用户
            if (imageList.length === 0) {
                toastr.info('图库已空，可自动恢复默认头像');
            }
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在保存 ${files.length} 张实体图片至后端...`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const savedPath = await saveImageToBackend(b64);
                imageList.push(savedPath);
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('实体图片保存完成！');
        };
        
        renderGrid();
    }, 100);
}

// ======================== 控制栏按钮注入 ========================

async function triggerNativeCropPopup(imgSrc, isUser, identifier, bindBtnEl) {
    const res = await fetch(imgSrc);
    const blob = await res.blob();
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    
    reader.onloadend = async () => {
        const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: reader.result });

        setTimeout(() => {
            const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
            if (cropperImg && cropperImg.cropper) {
                const cropper = cropperImg.cropper;
                cropper.setDragMode('move');
                cropper.options.wheelZoomRatio = 0.05;
            }
        }, 150);

        const croppedImageBase64 = await cropPromise;

        if (croppedImageBase64) {
            toastr.info("正在保存裁剪图片至后端...");
            const savedPath = await saveImageToBackend(croppedImageBase64);
            
            const theme = getCurrentTheme(); 
            if (!extension_settings.st_bindings[theme]) extension_settings.st_bindings[theme] = {};
            
            // 裁剪后自动激活绑定（仅针对聊天界面的CSS）
            extension_settings.st_bindings[theme][identifier] = savedPath;
            
            saveSettingsDebounced();
            applyThemeBindings(); 
            if (bindBtnEl) bindBtnEl.classList.add('bound-active');
            toastr.success('头像已裁剪，并自动绑定至当前主题 (仅聊天界面有效)');
        }
    };
}

function injectPanelButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const img = zoomedDiv.querySelector('img');
    if (!img) return;

    const { isUser, identifier } = getZoomedContext(img.src);
    const theme = getCurrentTheme();

    // 1. 绑定按钮 (Link)
    const btnBind = document.createElement('div');
    btnBind.id = 'st-bind-btn';
    btnBind.className = 'st-avatar-ctrl-btn';
    btnBind.title = '绑定到当前主题（仅在聊天区域生效）';
    
    // 检查当前是否已绑定
    if (extension_settings.st_bindings[theme] && extension_settings.st_bindings[theme][identifier]) {
        btnBind.classList.add('bound-active');
        btnBind.innerHTML = '<i class="fa-solid fa-link"></i>';
    } else {
        btnBind.innerHTML = '<i class="fa-solid fa-link-slash"></i>';
    }

    btnBind.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!extension_settings.st_bindings[theme]) extension_settings.st_bindings[theme] = {};
        
        if (btnBind.classList.contains('bound-active')) {
            // 解除绑定
            delete extension_settings.st_bindings[theme][identifier];
            btnBind.classList.remove('bound-active');
            btnBind.innerHTML = '<i class="fa-solid fa-link-slash"></i>';
            toastr.info('已解除当前主题的头像绑定，恢复默认。');
        } else {
            // 手动绑定（将当前图库中的原图保存并绑定）
            toastr.info('正在提取当前图片并绑定...');
            const savedPath = await saveImageToBackend(img.src);
            extension_settings.st_bindings[theme][identifier] = savedPath;
            btnBind.classList.add('bound-active');
            btnBind.innerHTML = '<i class="fa-solid fa-link"></i>';
            toastr.success('已将当前头像绑定至此主题');
        }
        saveSettingsDebounced();
        applyThemeBindings();
    });

    // 2. 剪裁按钮
    const btnCrop = document.createElement('div');
    btnCrop.id = 'st-native-crop-btn';
    btnCrop.className = 'st-avatar-ctrl-btn';
    btnCrop.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btnCrop.title = '剪裁头像 (将自动触发主题绑定)';
    btnCrop.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        zoomedDiv.click(); // 关闭放大面板
        await triggerNativeCropPopup(img.src, isUser, identifier, btnBind);
    });

    // 3. 图库按钮
    const btnGallery = document.createElement('div');
    btnGallery.id = 'st-gallery-btn';
    btnGallery.className = 'st-avatar-ctrl-btn';
    btnGallery.innerHTML = '<i class="fa-solid fa-images"></i>';
    btnGallery.title = '独立图库管理';
    btnGallery.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomedDiv.click(); // 关闭放大面板
        openGalleryPanel(isUser, identifier, img.src, btnBind);
    });

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(btnBind, closeBtn);
        controlBar.insertBefore(btnGallery, btnBind);
        controlBar.insertBefore(btnCrop, btnGallery);
    } else {
        controlBar.appendChild(btnCrop);
        controlBar.appendChild(btnGallery);
        controlBar.appendChild(btnBind);
    }
}

// ======================== 点击穿透及事件循环 ========================

function updateClickZoomState() {
    const isEnabled = !!extension_settings.avatarClickZoomEnabled;
    let pointerStyle = document.getElementById('st-avatar-crop-pointer-events');
    if (isEnabled) {
        if (!pointerStyle) {
            pointerStyle = document.createElement('style');
            pointerStyle.id = 'st-avatar-crop-pointer-events';
            document.head.appendChild(pointerStyle);
        }
        pointerStyle.textContent = `
            #chat .mes .mesAvatarWrapper .avatar, 
            #chat .mes .mesAvatarWrapper .avatar img {
                pointer-events: auto !important;
            }
        `;
    } else if (pointerStyle) {
        pointerStyle.remove();
    }
}

let lastTheme = getCurrentTheme();

setInterval(() => {
    // 监听主题切换，应用绑定
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyThemeBindings(); 
    }

    // 设置项注入
    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            const isEnabled = !!extension_settings.avatarClickZoomEnabled;
            container.innerHTML = `
                <span data-i18n="Avatar Click Zoom">头像点击放大：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole" title="开启后允许点击聊天界面的头像进行放大">
                    <option value="false" ${!isEnabled ? 'selected' : ''}>默认</option>
                    <option value="true" ${isEnabled ? 'selected' : ''}>启用</option>
                </select>
            `;
            targetContainer.appendChild(container);
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarClickZoomEnabled = (e.target.value === 'true');
                saveSettingsDebounced();
                updateClickZoomState();
            });
        }
    } catch (e) { }
}, 1000);

// ======================== 初始化入口 ========================

jQuery(async () => {
    applyThemeBindings();
    updateClickZoomState();
    
    console.log('[AvatarGallery & ThemeBinder] Successfully Loaded with Backend API.');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectPanelButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectPanelButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
