import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化设置空间
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

// 图片压缩器：防止用户上传巨大图片挤爆 localstorage，限制最大分辨率为 800x800，并转化为高压 JPEG
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
                resolve(canvas.toDataURL('image/jpeg', 0.85)); // 使用 JPG 压缩以节省空间
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// 根据 Base64 / URL 获取资源
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

// 渲染替换卡面 CSS (覆盖原图)
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

// 渲染剪裁头像 CSS (拥有最高优先级覆盖)
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

// 刷新状态：控制 CSS 和 UI 的显隐
function updateAvatarFeaturesState() {
    const isEnabled = !!extension_settings.avatarCropEnabled;

    // 1. 头像点击透传最高优先 CSS
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

    // 2. 隐藏或清除替换卡面按钮
    const altBtn = document.getElementById('st-alt-avatar-btn');
    if (altBtn) altBtn.style.display = isEnabled ? 'flex' : 'none';

    // 3. 应用或清空展示数据
    if (isEnabled) {
        applyAltAvatars();
        applyCroppedAvatars();
    } else {
        const cropStyle = document.getElementById('custom-avatar-crop-style');
        if (cropStyle) cropStyle.textContent = '';
        const altStyle = document.getElementById('custom-alt-avatar-style');
        if (altStyle) altStyle.textContent = '';
    }
}

// 打开替换卡面面板
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
    
    // 等待 DOM 渲染后绑定事件
    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const inputUpload = document.getElementById('input-alt-upload');
        let isDeleteMode = false;
        
        function renderGrid() {
            grid.innerHTML = '';
            
            // 渲染默认原图
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (data.selected === null ? ' selected' : '');
            origDiv.innerHTML = `<img src="${originalSrc}" title="原卡面">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            // 渲染所有上传的卡面
            data.images.forEach((b64, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (data.selected === index ? ' selected' : '');
                itemDiv.innerHTML = `
                    <img src="${b64}">
                    <div class="delete-btn" title="删除图片"><i class="fa-solid fa-xmark"></i></div>
                `;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) {
                        e.stopPropagation();
                        deleteAvatar(index);
                    } else {
                        selectAvatar(index);
                    }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        function selectAvatar(index) {
            if (isDeleteMode) return;
            data.selected = index;
            
            // 当更换底层卡面时，清空当前主题的剪裁缓存，防止逻辑冲突
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
                data.selected = null; // 删除了当前正在使用的，回退到原卡面
                applyAltAvatars();
            } else if (data.selected > index) {
                data.selected -= 1; // 修正索引
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
            inputUpload.value = ''; // 允许重复选择同名文件
        };
        
        renderGrid();
    }, 100);
}

// 调用原生裁剪弹窗
async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    let base64Original;

    // 智能识别：优先检查是否启用了“替换卡面”，如果有，则对替换后的卡面进行剪裁！
    if (extension_settings.altAvatars[avatarId] && extension_settings.altAvatars[avatarId].selected !== null) {
        const altData = extension_settings.altAvatars[avatarId];
        base64Original = altData.images[altData.selected];
    } else {
        base64Original = await getBase64FromUrl(imgSrc);
    }

    const cropPromise = callGenericPopup(
        '', 
        POPUP_TYPE.CROP, 
        '', 
        { cropAspect: 0, cropImage: base64Original }
    );

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
        if (!extension_settings.avatarCroppedImages[theme]) {
            extension_settings.avatarCroppedImages[theme] = {};
        }

        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        toastr.success('头像剪裁已保存');
    }
}

// 轮询注入 DOM 组件（防止被酒馆刷新掉）
setInterval(() => {
    // 主题变更监听
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        if (extension_settings.avatarCropEnabled) {
            applyCroppedAvatars(); 
        }
    }

    // 注入底层功能开关（在设置界面底部）
    const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
    if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
        const container = document.createElement('div');
        container.id = 'st-avatar-features-toggle-container';
        container.className = 'flex-container alignItemsCenter';
        const isEnabled = !!extension_settings.avatarCropEnabled;
        container.innerHTML = `
            <label class="checkbox_label" title="开启后允许点击头像进行裁剪，并在角色栏提供卡面替换功能">
                <input id="st-avatar-features-toggle" type="checkbox" ${isEnabled ? 'checked' : ''}>
                <span>启用头像剪裁与替换卡面功能</span>
            </label>
        `;
        targetContainer.appendChild(container);
        document.getElementById('st-avatar-features-toggle').addEventListener('change', (e) => {
            extension_settings.avatarCropEnabled = e.target.checked;
            saveSettingsDebounced();
            updateAvatarFeaturesState();
        });
    }

    // 注入“替换卡面”按钮
    if (extension_settings.avatarCropEnabled) {
        const avatarControls = document.querySelector('#avatar_controls > div');
        if (avatarControls && !document.getElementById('st-alt-avatar-btn')) {
            const btn = document.createElement('div');
            btn.id = 'st-alt-avatar-btn';
            btn.className = 'menu_button';
            btn.innerHTML = '<i class="fa-solid fa-images"></i> 替换卡面';
            btn.title = '为当前角色管理并替换全新的卡面图片';
            btn.addEventListener('click', openAltAvatarPanel);
            avatarControls.prepend(btn); // 插入最左侧
        }
    }
}, 1000);

// 注入放大预览面板中的剪裁按钮
function injectCropButton(zoomedDiv) {
    if (!extension_settings.avatarCropEnabled) return;
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const btn = document.createElement('div');
    btn.id = 'st-native-crop-btn';
    btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btn.title = '高级剪裁头像';

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

jQuery(async () => {
    updateAvatarFeaturesState();

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
