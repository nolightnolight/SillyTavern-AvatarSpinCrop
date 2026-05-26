import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

// 清理旧缓存
if (extension_settings.altAvatars) delete extension_settings.altAvatars;
if (extension_settings.avatarCroppedImages) delete extension_settings.avatarCroppedImages;

if (extension_settings.avatarGalleryPluginEnabled !== undefined) {
    extension_settings.avatarGalleryBtnVisible = extension_settings.avatarGalleryPluginEnabled;
    delete extension_settings.avatarGalleryPluginEnabled;
}
if (extension_settings.avatarClickZoomEnabled !== undefined) {
    extension_settings.avatarGalleryBtnVisible = extension_settings.avatarClickZoomEnabled;
    delete extension_settings.avatarClickZoomEnabled;
}
if (extension_settings.avatarGalleryBtnVisible === undefined) extension_settings.avatarGalleryBtnVisible = true;

if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};

if (extension_settings.avatarThemeCrops) {
    for (const theme in extension_settings.avatarThemeCrops) {
        for (const avatarId in extension_settings.avatarThemeCrops[theme]) {
            const val = extension_settings.avatarThemeCrops[theme][avatarId];
            if (typeof val === 'string') {
                const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
                extension_settings.avatarThemeCrops[theme][avatarId] = {};
                extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey] = val;
            }
        }
    }
}

function getAvatarIdFromSrc(src) {
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        if (fileParam) return decodeURIComponent(fileParam);
        
        const parts = urlObj.pathname.split('/');
        let filename = parts[parts.length - 1];
        return decodeURIComponent(filename);
    } catch (e) {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    }
}

function isUserAvatar(src) {
    if (!src) return false;
    const cleanSrc = decodeURIComponent(src);
    return cleanSrc.includes('User Avatars') || cleanSrc.includes('user/images') || cleanSrc.includes('User%20Avatars');
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function getBinding(theme, avatarId) {
    return extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || null;
}

let lastValidAvatarId = null;
setInterval(() => {
    const previewImg = document.getElementById('avatar_load_preview');
    if (previewImg) {
        const src = previewImg.getAttribute('src');
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
            lastValidAvatarId = getAvatarIdFromSrc(src);
        }
    }
}, 500);

// ======================== 后端操作 ========================

async function uploadToBackend(base64Data, prefix = "image") {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const filename = `${prefix}_${randomSuffix}`;
    
    const requestBody = {
        image: b64,
        format: 'png',
        ch_name: '', 
        filename: filename
    };
    
    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody)
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; 
        }
    } catch(e) {
        console.error('Upload failed', e);
    }
    return null;
}

async function uploadToBackendExact(base64Data, exactFilename) {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const requestBody = {
        image: b64,
        format: 'png',
        ch_name: '', 
        filename: exactFilename
    };
    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody)
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; 
        }
    } catch(e) {
        console.error('Upload exact crop failed', e);
    }
    return null;
}

async function deleteFromBackend(path) {
    try {
        const cleanPath = path.split('?')[0];
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: cleanPath })
        });
    } catch (e) {
        console.error('Delete failed', e);
    }
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    try {
        const fetchUrl = url.includes('?') ? url : `${url}?t=${Date.now()}`;
        const data = await fetch(fetchUrl);
        if (!data.ok) throw new Error(`HTTP ${data.status}`);
        const blob = await data.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Read blob failed'));
            reader.readAsDataURL(blob); 
        });
    } catch (error) {
        console.error("UrlToBase64 error: ", error);
        throw error;
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
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ======================== CSS 渲染管理 ========================

function applyAvatarCss() {
    let styleTag = document.getElementById('st-avatar-bindings-style');
    const theme = getCurrentTheme();
    const bindings = extension_settings.avatarThemeBindings?.[theme] || {};
    const crops = extension_settings.avatarThemeCrops?.[theme] || {};
    let cssString = '';
    
    const activeImages = {};
    const allAvatarIds = new Set([...Object.keys(bindings), ...Object.keys(crops)]);

    for (const avatarId of allAvatarIds) {
        if (avatarId === 'thumbnail') continue;
        const baseImageKey = bindings[avatarId] || avatarId;
        let displayPath = baseImageKey;

        if (crops[avatarId] && crops[avatarId][baseImageKey]) {
            displayPath = crops[avatarId][baseImageKey];
        }

        if (displayPath !== avatarId) {
            activeImages[avatarId] = displayPath;
        }
    }
    
    for (const [avatarId, imagePath] of Object.entries(activeImages)) {
        if (!imagePath) continue;
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        
        cssString += `
            .avatar img[src*="${escapedId}"],
            .avatar img[src*="${encodedId}"],
            #avatar_load_preview[src*="${escapedId}"],
            #avatar_load_preview[src*="${encodedId}"],
            .zoomed_avatar img[src*="${escapedId}"],
            .zoomed_avatar img[src*="${encodedId}"] {
                content: url("${imagePath}") !important;
                object-fit: cover !important;
            }
        `;
    }

    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-avatar-bindings-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function updatePluginState() {
    const isBtnVisible = !!extension_settings.avatarGalleryBtnVisible;
    applyAvatarCss();
    
    let btnVisibilityStyle = document.getElementById('st-avatar-btn-visibility');
    if (!btnVisibilityStyle) {
        btnVisibilityStyle = document.createElement('style');
        btnVisibilityStyle.id = 'st-avatar-btn-visibility';
        document.head.appendChild(btnVisibilityStyle);
    }
    
    if (isBtnVisible) {
        btnVisibilityStyle.textContent = ''; 
        document.querySelectorAll('.mes').forEach(injectChatButton);
    } else {
        btnVisibilityStyle.textContent = '.st-trigger-zoom-btn { display: none !important; }'; 
    }
}

async function deleteImages(pathsToDelete, avatarId, isUser) {
    if (isUser) {
        extension_settings.userGalleryImages = extension_settings.userGalleryImages.filter(p => !pathsToDelete.includes(p));
    } else {
        extension_settings.charGalleryImages[avatarId] = extension_settings.charGalleryImages[avatarId].filter(p => !pathsToDelete.includes(p));
    }

    if (extension_settings.avatarThemeBindings) {
        for (const theme in extension_settings.avatarThemeBindings) {
            const bindings = extension_settings.avatarThemeBindings[theme];
            if (pathsToDelete.includes(bindings[avatarId])) {
                delete bindings[avatarId];
            }
        }
    }
    if (extension_settings.avatarThemeCrops) {
        for (const theme in extension_settings.avatarThemeCrops) {
            if (extension_settings.avatarThemeCrops[theme][avatarId]) {
                for (const deletedPath of pathsToDelete) {
                    if (extension_settings.avatarThemeCrops[theme][avatarId][deletedPath]) {
                        deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId][deletedPath]);
                        delete extension_settings.avatarThemeCrops[theme][avatarId][deletedPath];
                    }
                }
            }
        }
    }

    for (const path of pathsToDelete) {
        await deleteFromBackend(path);
    }

    saveSettingsDebounced();
    applyAvatarCss();
}

// ======================== 图库面板业务 ========================

async function openGallery(isUser, avatarId, originalSrc, zoomedDiv) {
    if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
    if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
    if (!isUser && !extension_settings.charGalleryImages[avatarId]) extension_settings.charGalleryImages[avatarId] = [];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0; font-size:1.1em;">${isUser ? '用户图库' : '角色图库'}</h3>
                <div style="display:flex; gap:8px; align-items:center;">
                    ${!isUser ? `<div class="menu_button menu_button_icon margin0" id="btn-alt-import" title="导入"><i class="fa-solid fa-file-import"></i></div>
                                 <div class="menu_button menu_button_icon margin0" id="btn-alt-export" title="导出"><i class="fa-solid fa-file-export"></i></div>` : ''}
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button margin0" id="btn-alt-delete-confirm"><i class="fa-solid fa-trash-can"></i> <span>删除</span></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <input type="file" id="input-alt-import" style="display:none;" accept=".json">
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    const currentBinding = getBinding(getCurrentTheme(), avatarId);
    let tempSelectedPath = currentBinding;
    let isDeleteMode = false;
    let itemsToDelete = new Set();
    
    const avatarNamePrefix = avatarId.split('.')[0].replace(/^\d{13,}-/, '');

    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');
        const btnImport = document.getElementById('btn-alt-import');
        const btnExport = document.getElementById('btn-alt-export');
        const inputUpload = document.getElementById('input-alt-upload');
        const inputImport = document.getElementById('input-alt-import');

        function renderGrid() {
            grid.innerHTML = '';
            
            const cleanOriginalSrc = isUser ? `/User Avatars/${encodeURIComponent(avatarId)}` : `/characters/${encodeURIComponent(avatarId)}`;
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (!tempSelectedPath ? ' selected' : '');
            origDiv.innerHTML = `<img src="${cleanOriginalSrc}" title="恢复原图" onerror="this.src='img/ai4.png'">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            const images = isUser ? extension_settings.userGalleryImages : extension_settings.charGalleryImages[avatarId];
            if (images) {
                images.forEach((path) => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'alt-avatar-item' + (tempSelectedPath === path ? ' selected' : '');
                    if (itemsToDelete.has(path)) itemDiv.classList.add('to-delete');
                    
                    itemDiv.innerHTML = `<img src="${path}">`;
                    itemDiv.onclick = (e) => {
                        if (isDeleteMode) { 
                            e.stopPropagation(); 
                            toggleDeleteMark(path, itemDiv);
                        } else { 
                            selectAvatar(path); 
                        }
                    };
                    grid.appendChild(itemDiv);
                });
            }
        }
        
        function selectAvatar(path) {
            if (isDeleteMode) return;
            tempSelectedPath = path;
            renderGrid();
        }

        function toggleDeleteMark(path, element) {
            if (itemsToDelete.has(path)) {
                itemsToDelete.delete(path);
                element.classList.remove('to-delete');
            } else {
                itemsToDelete.add(path);
                element.classList.add('to-delete');
            }
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnUpload.style.display = 'none';
                if(btnImport) btnImport.style.display = 'none';
                if(btnExport) btnExport.style.display = 'none';
                btnDeleteConfirm.classList.add('active');
                itemsToDelete.clear();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnUpload.style.display = 'flex';
                if(btnImport) btnImport.style.display = 'flex';
                if(btnExport) btnExport.style.display = 'flex';
                btnDeleteConfirm.classList.remove('active');
                itemsToDelete.clear();
            }
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const confirm = await callGenericPopup(`是否确认删除选中的 ${itemsToDelete.size} 张图片？`, POPUP_TYPE.CONFIRM, '', { okButton: '确认', cancelButton: '取消' });
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;

            if (itemsToDelete.has(tempSelectedPath)) tempSelectedPath = null;
            await deleteImages(Array.from(itemsToDelete), avatarId, isUser);
            btnManage.click(); 
            toastr.success('已删除图片');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const path = await uploadToBackend(b64, avatarNamePrefix);
                if (path) {
                    if (isUser) extension_settings.userGalleryImages.push(path);
                    else extension_settings.charGalleryImages[avatarId].push(path);
                }
            }
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success(`图片上传成功`);
        };

        if (btnExport) {
            btnExport.onclick = async () => {
                const images = extension_settings.charGalleryImages[avatarId] || [];
                if (images.length === 0) return toastr.warning('图库为空');
                toastr.info('正在导出...');
                const exportData = [];
                for (const path of images) {
                    try { exportData.push(await getBase64FromUrl(path)); } catch(e) {}
                }
                const blob = new Blob([JSON.stringify(exportData)], {type: "application/json"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Avatar-${avatarNamePrefix}.json`;
                a.click();
                URL.revokeObjectURL(url);
            };
        }

        if (btnImport) {
            btnImport.onclick = () => inputImport.click();
            inputImport.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        for (const b64 of data) {
                            const path = await uploadToBackend(b64, avatarNamePrefix);
                            if (path) extension_settings.charGalleryImages[avatarId].push(path);
                        }
                        saveSettingsDebounced();
                        renderGrid();
                        toastr.success(`导入成功`);
                    } catch (err) {
                        toastr.error('导入失败');
                    }
                    inputImport.value = '';
                };
                reader.readAsText(file);
            };
        }
        
        renderGrid();
    }, 100);

    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: '选择此卡面', cancelButton: '取消' });
    
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        if (tempSelectedPath !== currentBinding) {
            const theme = getCurrentTheme();
            if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
            if (!extension_settings.avatarThemeBindings[theme]) extension_settings.avatarThemeBindings[theme] = {};
            
            if (tempSelectedPath === null) {
                delete extension_settings.avatarThemeBindings[theme][avatarId];
            } else {
                extension_settings.avatarThemeBindings[theme][avatarId] = tempSelectedPath;
            }

            saveSettingsDebounced();
            applyAvatarCss();
            
            if (zoomedDiv) {
                const closeBtn = zoomedDiv.querySelector('.dragClose');
                if (closeBtn) closeBtn.click();
            }
        }
    }
}

// ======================== 裁剪业务及自由旋转注入 ========================

async function triggerNativeCropPopup(imgSrc, avatarId, isUser, zoomedDiv) {
    if (avatarId === 'thumbnail') return toastr.error('无法获取图片');

    const theme = getCurrentTheme();
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    let sourcePath = extension_settings.avatarThemeBindings?.[theme]?.[avatarId];

    if (!sourcePath) {
        sourcePath = isUser ? `/User Avatars/${encodeURIComponent(avatarId)}` : `/characters/${encodeURIComponent(avatarId)}`;
    } else if (!sourcePath.startsWith('/') && !sourcePath.startsWith('http') && !sourcePath.startsWith('data:')) {
        sourcePath = '/' + sourcePath;
    }

    let base64Original;
    try {
        base64Original = await getBase64FromUrl(sourcePath);
    } catch (e) {
        toastr.error('获取原图数据失败，无法进行裁剪，请从图库重新上传。');
        return;
    }

    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    // 轮询等待 Cropper 初始化，完美兼容手机端注入
    const checkCropperInterval = setInterval(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            clearInterval(checkCropperInterval);
            const cropper = cropperImg.cropper;
            cropper.setDragMode('move');
            cropper.options.wheelZoomRatio = 0.05;

            // 动态向裁剪窗口的 Body 顶部注入旋转控件，确保手机端绝对可见且不遮挡
            const popupBody = document.querySelector('#dialogue_popup .popup-body');
            if (popupBody && !document.getElementById('st-avatar-rotation-container')) {
                const rotContainer = document.createElement('div');
                rotContainer.id = 'st-avatar-rotation-container';
                rotContainer.className = 'st-rotation-container';

                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-rotate';

                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = '-180';
                slider.max = '180';
                slider.value = '0';
                slider.className = 'st-rotation-slider';

                const valDisplay = document.createElement('span');
                valDisplay.textContent = '0°';
                valDisplay.style.minWidth = '40px';
                valDisplay.style.textAlign = 'right';

                // 核心：无级自由旋转逻辑监听
                const updateRotation = (val) => {
                    const deg = parseInt(val, 10);
                    valDisplay.textContent = deg + '°';
                    cropper.rotateTo(deg);
                };

                slider.addEventListener('input', (e) => updateRotation(e.target.value));
                slider.addEventListener('change', (e) => updateRotation(e.target.value));

                rotContainer.appendChild(icon);
                rotContainer.appendChild(slider);
                rotContainer.appendChild(valDisplay);

                // 强制将滑块插入到裁剪视图的最上方
                popupBody.insertBefore(rotContainer, popupBody.firstChild);
            }
        }
    }, 50);

    // 设定 4 秒超时保险线，防止死循环
    setTimeout(() => clearInterval(checkCropperInterval), 4000);

    const croppedImageBase64 = await cropPromise;

    if (croppedImageBase64) {
        let cleanSrc = sourcePath.split('?')[0];
        let filenameWithExt = cleanSrc.split('/').pop();
        let baseImageName = decodeURIComponent(filenameWithExt).replace(/\.[^/.]+$/, "");
        
        baseImageName = baseImageName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '');
        const safeThemeName = theme.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '');
        const exactFilename = `${baseImageName}_${safeThemeName}_1`;

        if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};
        if (!extension_settings.avatarThemeCrops[theme]) extension_settings.avatarThemeCrops[theme] = {};
        if (!extension_settings.avatarThemeCrops[theme][avatarId]) extension_settings.avatarThemeCrops[theme][avatarId] = {};

        if (extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey]) {
            await deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey]);
        }

        const path = await uploadToBackendExact(croppedImageBase64, exactFilename);
        if (!path) return toastr.error('保存裁剪失败');

        extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey] = `${path}?t=${Date.now()}`;
        
        saveSettingsDebounced();
        applyAvatarCss(); 
        toastr.success('裁剪并应用成功');

        if (zoomedDiv) {
            const closeBtn = zoomedDiv.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
        }
    }
}

// ======================== DOM 元素快捷键注入与触发逻辑 ========================

function injectChatButton(mesNode) {
    const btnContainer = mesNode.querySelector('.mes_buttons');
    if (!btnContainer || btnContainer.querySelector('.st-trigger-zoom-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button st-trigger-zoom-btn fa-solid fa-image-portrait';
    btn.title = '图库';
    
    btnContainer.insertBefore(btn, btnContainer.firstChild);
}

function injectControlBarButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('.st-avatar-injected-btns')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    zoomedDiv.style.removeProperty('height');
    zoomedDiv.style.removeProperty('width');

    const btnContainer = document.createElement('div');
    btnContainer.className = 'st-avatar-injected-btns';

    const img = zoomedDiv.querySelector('img');
    if (!img) return;
    const originalSrc = img.src;
    const avatarId = getAvatarIdFromSrc(originalSrc);
    const isUser = isUserAvatar(originalSrc);
    const theme = getCurrentTheme();

    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'fa-solid fa-crop-simple';
    cropBtn.onclick = async (e) => {
        e.stopPropagation(); 
        await triggerNativeCropPopup(originalSrc, avatarId, isUser, zoomedDiv);
    };

    const revertBtn = document.createElement('div');
    revertBtn.id = 'st-revert-crop-btn';
    revertBtn.className = 'fa-solid fa-arrow-rotate-left';
    
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    revertBtn.style.display = extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey] ? 'flex' : 'none';

    revertBtn.onclick = async (e) => {
        e.stopPropagation();
        if (extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey]) {
            const cropPath = extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey];
            await deleteFromBackend(cropPath);
            delete extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey];
            saveSettingsDebounced();
            applyAvatarCss();
            toastr.success('已还原');
            revertBtn.style.display = 'none';
            
            const closeBtn = zoomedDiv.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
        }
    };

    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'fa-solid fa-images';
    galleryBtn.onclick = (e) => {
        e.stopPropagation();
        openGallery(isUser, avatarId, originalSrc, zoomedDiv);
    };

    btnContainer.appendChild(revertBtn);
    btnContainer.appendChild(cropBtn);
    btnContainer.appendChild(galleryBtn);

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btnContainer, closeBtn);
    else controlBar.appendChild(btnContainer);
}

// 核心重构：双端通用的头像触控/点击直接呼出图库机制
function bindGlobalAvatarInterceptors() {
    // 释放可能残存绑定的旧事件，防止多次堆叠
    $(document).off('pointerdown touchstart', '.mes .mesAvatarWrapper');

    // 智能捕捉触摸和点击：轻触或点击头像区域，绕过中间层，直达图库
    $(document).on('pointerdown touchstart', '.mes .mesAvatarWrapper', function(e) {
        const avatarImg = $(this).find('.avatar img');
        if (!avatarImg.length) return;
        
        const src = avatarImg.attr('src');
        if (!src) return;

        // 记录按下时间，用于实现完美的移动端双击/单触控稳定识别
        const now = Date.now();
        const lastTouch = $(this).data('lastTouch') || 0;
        $(this).data('lastTouch', now);

        // 如果用户在 350 毫秒内连续点击/轻触头像，或者直接单次触发
        if (now - lastTouch < 350 || e.type === 'pointerdown') {
            e.preventDefault();
            e.stopPropagation();
            
            const avatarId = getAvatarIdFromSrc(src);
            const isUser = isUserAvatar(src);
            
            // 绕过所有放大中间层，直接开辟图库窗体
            openGallery(isUser, avatarId, src, null);
        }
    });

    // 消息右上角小图标的点击/触控事件拦截
    $(document).off('click pointerdown', '.st-trigger-zoom-btn');
    $(document).on('click pointerdown', '.st-trigger-zoom-btn', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const avatarImg = $(this).closest('.mes').find('.mesAvatarWrapper .avatar img');
        if (avatarImg.length) {
            const src = avatarImg.attr('src');
            const avatarId = getAvatarIdFromSrc(src);
            const isUser = isUserAvatar(src);
            openGallery(isUser, avatarId, src, null);
        }
    });
}

// ======================== 初始化周期 ========================

let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyAvatarCss(); 
    }
}, 1000);

setInterval(() => {
    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            const isVisible = !!extension_settings.avatarGalleryBtnVisible;
            container.innerHTML = `
                <span data-i18n="Avatar Gallery Management">头像图库管理：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole">
                    <option value="false" ${!isVisible ? 'selected' : ''}>隐藏右上角图标</option>
                    <option value="true" ${isVisible ? 'selected' : ''}>显示右上角图标</option>
                </select>
            `;
            targetContainer.appendChild(container);
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarGalleryBtnVisible = (e.target.value === 'true');
                saveSettingsDebounced();
                updatePluginState();
            });
        }
    } catch (e) { }
}, 1000);

jQuery(async () => {
    updatePluginState();
    bindGlobalAvatarInterceptors();

    // 监听原生图片上传动作，做配置继承清洗
    document.body.addEventListener('change', (e) => {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
            const id = e.target.id;
            if (['add_avatar_button', 'character_replace_file', 'avatar_upload_file', 'group_avatar_button'].includes(id)) {
                let oldAvatarId = lastValidAvatarId;
                const previewImg = document.getElementById('avatar_load_preview') || document.querySelector('#group_avatar_preview .avatar img');
                
                if (previewImg) {
                    const src = previewImg.getAttribute('src');
                    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                        oldAvatarId = getAvatarIdFromSrc(src);
                    }
                }

                if (oldAvatarId && oldAvatarId !== 'thumbnail') {
                    let checkCount = 0;
                    const migrateInterval = setInterval(() => {
                        checkCount++;
                        if (previewImg) {
                            const currentSrc = previewImg.getAttribute('src');
                            if (currentSrc && !currentSrc.startsWith('blob:') && !currentSrc.startsWith('data:')) {
                                const newAvatarId = getAvatarIdFromSrc(currentSrc);
                                if (newAvatarId !== oldAvatarId && newAvatarId !== 'thumbnail') {
                                    if (extension_settings.charGalleryImages && extension_settings.charGalleryImages[oldAvatarId]) {
                                        extension_settings.charGalleryImages[newAvatarId] = JSON.parse(JSON.stringify(extension_settings.charGalleryImages[oldAvatarId]));
                                        delete extension_settings.charGalleryImages[oldAvatarId];
                                    }
                                    if (extension_settings.avatarThemeBindings) {
                                        for (const t in extension_settings.avatarThemeBindings) {
                                            if (extension_settings.avatarThemeBindings[t][oldAvatarId]) {
                                                extension_settings.avatarThemeBindings[t][newAvatarId] = extension_settings.avatarThemeBindings[t][oldAvatarId];
                                                delete extension_settings.avatarThemeBindings[t][oldAvatarId];
                                            }
                                        }
                                    }
                                    if (extension_settings.avatarThemeCrops) {
                                        for (const t in extension_settings.avatarThemeCrops) {
                                            if (extension_settings.avatarThemeCrops[t][oldAvatarId]) {
                                                const oldOriginalCropPath = extension_settings.avatarThemeCrops[t][oldAvatarId][oldAvatarId];
                                                if (oldOriginalCropPath) {
                                                    deleteFromBackend(oldOriginalCropPath);
                                                    delete extension_settings.avatarThemeCrops[t][oldAvatarId][oldAvatarId];
                                                }
                                                extension_settings.avatarThemeCrops[t][newAvatarId] = extension_settings.avatarThemeCrops[t][oldAvatarId];
                                                delete extension_settings.avatarThemeCrops[t][oldAvatarId];
                                            }
                                        }
                                    }
                                    saveSettingsDebounced();
                                    applyAvatarCss();
                                }
                                clearInterval(migrateInterval);
                            }
                        }
                        if (checkCount > 20) clearInterval(migrateInterval);
                    }, 500);
                }
            }
        }
    });

    console.log('[Avatar Gallery & SpinCropper] Dual-platform Engine Loaded.');

    const observer = new MutationObserver((mutations) => {
        let shouldRebind = false;
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectControlBarButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectControlBarButtons(zoomed);
                    }
                    
                    if (node.classList.contains('mes')) {
                        injectChatButton(node);
                        shouldRebind = true;
                    } else {
                        const messages = node.querySelectorAll('.mes');
                        if (messages.length > 0) {
                            messages.forEach(injectChatButton);
                            shouldRebind = true;
                        }
                    }
                }
            });
        });
        if (shouldRebind) bindGlobalAvatarInterceptors();
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
