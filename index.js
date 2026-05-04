import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
if (extension_settings.avatarCropEnabled === undefined) extension_settings.avatarCropEnabled = false;
if (!extension_settings.avatarCroppedImages) extension_settings.avatarCroppedImages = {};
if (!extension_settings.altAvatars) extension_settings.altAvatars = {};

function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

// 智能图像压缩：防止挤爆缓存，最大限制为 800x800 的 JPG
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
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
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

// ======================== CSS 生成引擎 ========================

function applyAltAvatars() {
    let cssString = '';
    for (const [avatarId, data] of Object.entries(extension_settings.altAvatars)) {
        if (data.selected !== null && data.images[data.selected]) {
            const escapedId = avatarId.replace(/"/g, '\\"');
            const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
            const b64 = data.images[data.selected];

            cssString += `
                #chat .avatar img[src*="${escapedId}"],
                #chat .avatar img[src*="${encodedId}"],
                #sheld .avatar img[src*="${escapedId}"],
                #sheld .avatar img[src*="${encodedId}"],
                #avatar_load_preview[src*="${escapedId}"],
                #avatar_load_preview[src*="${encodedId}"],
                .zoomed_avatar img[src*="${escapedId}"],
                .zoomed_avatar img[src*="${encodedId}"] {
                    content: url("${b64}");
                }
            `;
        }
    }
    let styleTag = document.getElementById('custom-alt-avatar-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-alt-avatar-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function applyCroppedAvatars() {
    const theme = getCurrentTheme();
    const croppedData = extension_settings.avatarCroppedImages[theme] || {};
    let cssString = '';
    
    for (const [avatarId, base64Image] of Object.entries(croppedData)) {
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        cssString += `
            #chat .avatar img[src*="${escapedId}"],
            #chat .avatar img[src*="${encodedId}"],
            #sheld .avatar img[src*="${escapedId}"],
            #sheld .avatar img[src*="${encodedId}"] {
                content: url("${base64Image}");
                object-fit: cover !important;
            }
        `;
    }
    let styleTag = document.getElementById('custom-avatar-crop-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-crop-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function updateAvatarFeaturesState() {
    const isEnabled = !!extension_settings.avatarCropEnabled;

    // 1. 头像点击穿透 (强制优先级)
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

    // 2. 显示/隐藏 替换卡面按钮
    const altBtn = document.getElementById('st-alt-avatar-btn');
    if (altBtn) altBtn.style.display = isEnabled ? 'flex' : 'none';

    // 3. 渲染数据
    if (isEnabled) {
        applyAltAvatars();
        applyCroppedAvatars();
    } else {
        if (document.getElementById('custom-avatar-crop-style')) document.getElementById('custom-avatar-crop-style').textContent = '';
        if (document.getElementById('custom-alt-avatar-style')) document.getElementById('custom-alt-avatar-style').textContent = '';
    }
}

// ======================== 替换卡面面板 ========================

async function openAltAvatarPanel() {
    const previewImg = document.getElementById('avatar_load_preview');
    if (!previewImg || !previewImg.src) {
        toastr.warning('请先在侧边栏选择一个角色！');
        return;
    }
    
    const avatarId = getAvatarIdFromSrc(previewImg.src);
    const originalSrc = previewImg.src.split('?')[0]; 
    
    if (!extension_settings.altAvatars[avatarId]) {
        extension_settings.altAvatars[avatarId] = { selected: null, images: [] };
    }
    const data = extension_settings.altAvatars[avatarId];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <h2 style="margin-top: 0;">替换卡面</h2>
            <div style="display:flex; gap:10px;">
                <div class="menu_button" id="btn-alt-upload"><i class="fa-solid fa-upload"></i> 上传图片</div>
                <div class="menu_button" id="btn-alt-manage"><i class="fa-solid fa-trash-can"></i> 管理列表</div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*">
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;
    
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
    
    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const inputUpload = document.getElementById('input-alt-upload');
        let isDeleteMode = false;
        
        function renderGrid() {
            grid.innerHTML = '';
            
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (data.selected === null ? ' selected' : '');
            origDiv.innerHTML = `<img src="${originalSrc}" title="默认卡面">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            data.images.forEach((b64, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (data.selected === index ? ' selected' : '');
                itemDiv.innerHTML = `<img src="${b64}"><div class="delete-btn" title="删除图片"><i class="fa-solid fa-xmark"></i></div>`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) { e.stopPropagation(); deleteAvatar(index); } 
                    else { selectAvatar(index); }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        function selectAvatar(index) {
            if (isDeleteMode) return;
            data.selected = index;
            
            // 清理对应剪裁缓存以避免冲突
            const theme = getCurrentTheme();
            if (extension_settings.avatarCroppedImages && extension_settings.avatarCroppedImages[theme]) {
                delete extension_settings.avatarCroppedImages[theme][avatarId];
            }
            
            saveSettingsDebounced();
            applyAltAvatars();
            applyCroppedAvatars(); 
            renderGrid();
        }
        
        function deleteAvatar(index) {
            if (data.selected === index) {
                data.selected = null;
                applyAltAvatars();
            } else if (data.selected > index) {
                data.selected -= 1;
            }
            data.images.splice(index, 1);
            saveSettingsDebounced();
            renderGrid();
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            btnManage.style.color = isDeleteMode ? '#ff4444' : '';
            grid.classList.toggle('delete-mode', isDeleteMode);
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const b64 = await resizeImageToBase64(file);
            data.images.push(b64);
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
        };
        
        renderGrid();
    }, 100);
}

// ======================== 原生剪裁弹窗 ========================

async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    let base64Original;

    // 智能识别：优先剪裁已替换的卡面
    if (extension_settings.altAvatars[avatarId] && extension_settings.altAvatars[avatarId].selected !== null) {
        const altData = extension_settings.altAvatars[avatarId];
        base64Original = altData.images[altData.selected];
    } else {
        base64Original = await getBase64FromUrl(imgSrc);
    }

    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

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
        const theme = getCurrentTheme(); 
        if (!extension_settings.avatarCroppedImages[theme]) extension_settings.avatarCroppedImages[theme] = {};
        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        toastr.success('头像剪裁已保存');
    }
}

function injectCropButton(zoomedDiv) {
    if (!extension_settings.avatarCropEnabled) return;
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const btn = document.createElement('div');
    btn.id = 'st-native-crop-btn';
    btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btn.title = '剪裁头像';

    btn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        const img = zoomedDiv.querySelector('img');
        if (img) {
            zoomedDiv.click(); 
            await triggerNativeCropPopup(img.src);
        }
    });

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btn, closeBtn);
    else controlBar.appendChild(btn);
}

// ======================== 安全 DOM 注入轮询引擎 ========================

let lastTheme = getCurrentTheme();

setInterval(() => {
    // 1. 监听主题变化
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        if (extension_settings.avatarCropEnabled) applyCroppedAvatars(); 
    }

    // 2. 注入总开关 (精准定位到 index.html 中对应的区域)
    try {
        const targetContainer = document.querySelector('div[name="AvatarAndChatDisplay"]');
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline'; // 匹配原生风格
            
            const isEnabled = !!extension_settings.avatarCropEnabled;
            container.innerHTML = `
                <span data-i18n="Avatar Features">头像管理:</span>
                <label class="checkbox_label flex1 margin0" title="开启后允许点击头像进行裁剪，并在角色栏提供卡面替换功能">
                    <input id="st-avatar-features-toggle" type="checkbox" ${isEnabled ? 'checked' : ''}>
                    <span>启用头像剪裁与替换卡面功能</span>
                </label>
            `;
            targetContainer.appendChild(container); // 安全追加到末尾
            
            document.getElementById('st-avatar-features-toggle').addEventListener('change', (e) => {
                extension_settings.avatarCropEnabled = e.target.checked;
                saveSettingsDebounced();
                updateAvatarFeaturesState();
            });
        }
    } catch (e) { /* 防止抛出异常破坏酒馆原生进程 */ }

    // 3. 注入“替换卡面”按钮 (精确插入到下方按钮栏左侧)
    try {
        if (extension_settings.avatarCropEnabled) {
            const avatarControls = document.querySelector('#avatar_controls .form_create_bottom_buttons_block');
            if (avatarControls && !document.getElementById('st-alt-avatar-btn')) {
                const btn = document.createElement('div');
                btn.id = 'st-alt-avatar-btn';
                btn.className = 'menu_button fa-solid fa-images';
                btn.title = '替换卡面 (为当前角色独立管理新头像)';
                btn.addEventListener('click', openAltAvatarPanel);
                
                // 插入最左侧
                avatarControls.prepend(btn);
            }
        }
    } catch (e) {}
}, 1000);

jQuery(async () => {
    updateAvatarFeaturesState();
    console.log('[AvatarCropper] Successfully Loaded with Safety Checks.');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectCropButton(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectCropButton(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
