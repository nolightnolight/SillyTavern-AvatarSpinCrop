import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
if (extension_settings.avatarClickZoomEnabled === undefined) extension_settings.avatarClickZoomEnabled = false;
if (!extension_settings.altAvatars) extension_settings.altAvatars = {};
if (!extension_settings.altAvatars['user_pool']) extension_settings.altAvatars['user_pool'] = [];
if (!extension_settings.themeBindings) extension_settings.themeBindings = {};

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function getAvatarIdFromSrc(src) {
    if (!src) return null;
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

function isUserAvatar(src) {
    if (!src) return false;
    return src.includes('User Avatars') || src.includes('user_avatar');
}

// 记录当前真正有效的文件名（过滤掉临时 blob 路径）
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

// ======================== 图片文件实体化 API ========================

async function uploadImageToServer(base64Data) {
    try {
        const raw = base64Data.split(',')[1];
        const name = 'alt_avatar_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                image: raw,
                format: 'png',
                ch_name: 'alt_avatars', // 保存路径为 data/default-user/user/images/alt_avatars/
                filename: name
            })
        });
        if (res.ok) {
            const data = await res.json();
            return data.path; // 返回相对路径
        }
    } catch (e) { console.error('Image upload failed', e); }
    return null;
}

async function deleteImageFromServer(path) {
    if (!path || path.startsWith('data:')) return;
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: path })
        });
    } catch (e) { console.error('Image delete failed', e); }
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    const data = await fetch(url.startsWith('/') ? url : '/' + url);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob); 
        reader.onloadend = () => resolve(reader.result);
    });
}

// ======================== 数据迁移功能 ========================
// 将旧版 Base64 迁移到服务器实体文件系统，减少 settings.json 体积
async function migrateOldBase64ToFiles() {
    if (extension_settings.altAvatarsMigrated_v2) return;
    console.log('[AvatarCropper] Migrating old Base64 images to server files...');
    
    // 迁移旧版图库数据
    for (const [id, data] of Object.entries(extension_settings.altAvatars)) {
        if (id === 'user_pool') continue;
        if (Array.isArray(data)) continue; // 已经是新版格式
        
        const newPaths = [];
        if (data && data.images && Array.isArray(data.images)) {
            for (const b64 of data.images) {
                if (b64.startsWith('data:')) {
                    const path = await uploadImageToServer(b64);
                    if (path) newPaths.push(path);
                } else {
                    newPaths.push(b64);
                }
            }
        }
        extension_settings.altAvatars[id] = newPaths;
    }

    // 迁移旧版裁切图片为主绑定数据
    if (extension_settings.avatarCroppedImages) {
        for (const [theme, chars] of Object.entries(extension_settings.avatarCroppedImages)) {
            if (!extension_settings.themeBindings[theme]) extension_settings.themeBindings[theme] = {};
            for (const [id, b64] of Object.entries(chars)) {
                if (b64.startsWith('data:')) {
                    const path = await uploadImageToServer(b64);
                    if (path) extension_settings.themeBindings[theme][id] = path;
                }
            }
        }
        delete extension_settings.avatarCroppedImages;
    }
    
    extension_settings.altAvatarsMigrated_v2 = true;
    saveSettingsDebounced();
    console.log('[AvatarCropper] Migration completed.');
}

// ======================== CSS 注入引擎 ========================

function applyThemeBindings() {
    const theme = getCurrentTheme();
    const bindings = extension_settings.themeBindings[theme] || {};
    let cssString = '';
    
    for (const [avatarId, imgPath] of Object.entries(bindings)) {
        if (avatarId === 'thumbnail' || avatarId === 'user_pool') continue;

        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        cssString += `
            .avatar img[src*="${escapedId}"],
            .avatar img[src*="${encodedId}"],
            #avatar_load_preview[src*="${escapedId}"],
            #avatar_load_preview[src*="${encodedId}"] {
                content: url("/${imgPath}") !important;
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

// ======================== 核心操作逻辑 ========================

function toggleBinding(avatarId, currentImagePath, bindBtnElement) {
    if (!avatarId) return toastr.warning('无法识别头像ID');
    const theme = getCurrentTheme();
    if (!extension_settings.themeBindings[theme]) extension_settings.themeBindings[theme] = {};

    const boundPath = extension_settings.themeBindings[theme][avatarId];
    // currentImagePath 可能是带域名的URL或相对路径，做一个简单匹配
    if (boundPath && currentImagePath.includes(boundPath)) {
        // 解除绑定
        delete extension_settings.themeBindings[theme][avatarId];
        toastr.info('已解除当前主题的头像绑定，恢复默认');
    } else {
        // 提取纯路径
        let pathUrl = currentImagePath;
        try { pathUrl = new URL(currentImagePath).pathname.substring(1); } catch(e){}
        
        extension_settings.themeBindings[theme][avatarId] = pathUrl;
        toastr.success('头像已绑定至当前主题');
    }
    
    saveSettingsDebounced();
    applyThemeBindings();
    if (bindBtnElement) updateBindBtnState(bindBtnElement, avatarId, currentImagePath);
}

function updateBindBtnState(btnElement, avatarId, currentImagePath) {
    const theme = getCurrentTheme();
    const boundPath = extension_settings.themeBindings[theme]?.[avatarId];
    
    if (boundPath && currentImagePath.includes(boundPath)) {
        btnElement.classList.add('st-bound-active');
        btnElement.title = '已绑定当前主题 (点击解绑)';
    } else {
        btnElement.classList.remove('st-bound-active');
        btnElement.title = '未绑定 (点击绑定至当前主题)';
    }
}

// ======================== 替换卡面图库面板 ========================

async function openAltAvatarPanel(avatarId, isUser, originalSrc) {
    const dataPoolKey = isUser ? 'user_pool' : avatarId;
    if (!extension_settings.altAvatars[dataPoolKey]) {
        extension_settings.altAvatars[dataPoolKey] = [];
    }
    const pathsArray = extension_settings.altAvatars[dataPoolKey];
    
    const theme = getCurrentTheme();
    const currentBoundPath = extension_settings.themeBindings[theme]?.[avatarId];

    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '用户头像图库' : '角色卡面图库'}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    ${!isUser ? `
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-import" title="导入图库"><i class="fa-solid fa-file-import"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-export" title="导出图库"><i class="fa-solid fa-file-export"></i></div>
                    ` : ''}
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理/删除图片"><i class="fa-solid fa-trash-can"></i></div>
                    
                    <div id="btn-alt-delete-confirm">
                        <i class="fa-solid fa-trash-can"></i> <span style="font-size:14px; margin-left:5px; font-weight:bold;">确认删除 (0)</span>
                    </div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <input type="file" id="input-alt-import" style="display:none;" accept=".json">
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
        const btnExport = document.getElementById('btn-alt-export');
        const btnImport = document.getElementById('btn-alt-import');
        const inputImport = document.getElementById('input-alt-import');
        
        let isDeleteMode = false;
        let itemsToDelete = new Set();
        
        function updateDeleteConfirmBtn() {
            btnDeleteConfirm.querySelector('span').textContent = `确认删除 (${itemsToDelete.size})`;
        }

        function renderGrid() {
            grid.innerHTML = '';
            
            // 原始图片
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (!currentBoundPath ? ' selected' : '');
            origDiv.innerHTML = `<img src="${originalSrc}" title="默认原始图片" onerror="this.src='img/ai4.png'">`;
            origDiv.onclick = () => {
                if(isDeleteMode) return toastr.info("无法删除原始图片");
                if(extension_settings.themeBindings[theme]) {
                    delete extension_settings.themeBindings[theme][avatarId];
                    saveSettingsDebounced();
                    applyThemeBindings();
                    renderGrid();
                    toastr.success('已恢复为默认原始图片');
                }
            };
            grid.appendChild(origDiv);
            
            // 自定义图库图片
            pathsArray.forEach((imgPath, index) => {
                const isBound = imgPath === currentBoundPath;
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (isBound ? ' selected' : '');
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="/${imgPath}" title="应用此图片">`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        toggleDeleteMark(index, itemDiv);
                    } else { 
                        // 自动绑定到当前主题
                        if (!extension_settings.themeBindings[theme]) extension_settings.themeBindings[theme] = {};
                        extension_settings.themeBindings[theme][avatarId] = imgPath;
                        saveSettingsDebounced();
                        applyThemeBindings();
                        renderGrid(); // 重新渲染高亮框
                        toastr.success('已将此图片绑定至当前主题');
                    }
                };
                grid.appendChild(itemDiv);
            });
        }

        function toggleDeleteMark(index, element) {
            if (itemsToDelete.has(index)) {
                itemsToDelete.delete(index);
                element.classList.remove('to-delete');
            } else {
                itemsToDelete.add(index);
                element.classList.add('to-delete');
            }
            updateDeleteConfirmBtn();
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '退出删除模式';
                btnUpload.style.display = 'none';
                if(btnExport) btnExport.style.display = 'none';
                if(btnImport) btnImport.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                itemsToDelete.clear();
                updateDeleteConfirmBtn();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理/删除图片';
                btnUpload.style.display = 'flex';
                if(btnExport) btnExport.style.display = 'flex';
                if(btnImport) btnImport.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();

            const confirm = await callGenericPopup(`即将永久删除 ${itemsToDelete.size} 张图片并清空它们的绑定数据，是否继续？`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            
            for (const index of indexes) {
                const pathToDelete = pathsArray[index];
                pathsArray.splice(index, 1); // 1. 从图库列表中移除
                
                // 2. 清理所有主题中对该图片的绑定
                for (let t in extension_settings.themeBindings) {
                    if (extension_settings.themeBindings[t][avatarId] === pathToDelete) {
                        delete extension_settings.themeBindings[t][avatarId];
                    }
                }
                
                // 3. 从服务器端删除实体文件
                await deleteImageFromServer(pathToDelete);
            }

            saveSettingsDebounced();
            applyThemeBindings(); // 重新应用CSS，如果被删图正在使用，将自动掉落回默认图
            btnManage.click(); 
            toastr.success('已成功删除图片并清理相关绑定');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在处理上传 ${files.length} 张图片...`);
            for(let i = 0; i < files.length; i++) {
                const reader = new FileReader();
                reader.readAsDataURL(files[i]);
                await new Promise(resolve => {
                    reader.onload = async () => {
                        const path = await uploadImageToServer(reader.result);
                        if (path) pathsArray.push(path);
                        resolve();
                    };
                });
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('图片上传完成');
        };

        // 导出导入功能（仅限Char）
        if (btnExport) {
            btnExport.onclick = async () => {
                if (pathsArray.length === 0) return toastr.warning('当前角色图库为空，无法导出');
                toastr.info('正在打包图库数据，请稍候...');
                const exportData = {};
                for (let p of pathsArray) {
                    exportData[p] = await getBase64FromUrl('/' + p);
                }
                const blob = new Blob([JSON.stringify(exportData)], {type: 'application/json'});
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `${avatarId}_gallery_export.json`;
                link.click();
                toastr.success('导出完成');
            };
        }

        if (btnImport) {
            btnImport.onclick = () => inputImport.click();
            inputImport.onchange = async (e) => {
                const file = e.target.files[0];
                if(!file) return;
                toastr.info('正在导入图库并生成文件，请稍候...');
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    for (let b64 of Object.values(data)) {
                        const newPath = await uploadImageToServer(b64);
                        if(newPath) pathsArray.push(newPath);
                    }
                    saveSettingsDebounced();
                    renderGrid();
                    toastr.success('导入完成');
                } catch(err) {
                    toastr.error('解析文件失败');
                }
                inputImport.value = '';
            };
        }
        
        renderGrid();
    }, 100);
}

// ======================== 原生剪裁拦截与控制栏注入 ========================

async function triggerNativeCropPopup(imgSrc, avatarId) {
    if (avatarId === 'thumbnail') return toastr.error('图片获取异常，无法剪裁');

    const base64Original = await getBase64FromUrl(imgSrc);
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
        toastr.info('正在保存裁剪图片...');
        const newPath = await uploadImageToServer(croppedImageBase64);
        if (newPath) {
            const theme = getCurrentTheme(); 
            if (!extension_settings.themeBindings[theme]) extension_settings.themeBindings[theme] = {};
            
            // 自动绑定到当前主题
            extension_settings.themeBindings[theme][avatarId] = newPath;
            
            // 如果是User或者Char，都静默加入它们的图库
            const poolKey = isUserAvatar(imgSrc) ? 'user_pool' : avatarId;
            if (!extension_settings.altAvatars[poolKey]) extension_settings.altAvatars[poolKey] = [];
            extension_settings.altAvatars[poolKey].push(newPath);

            saveSettingsDebounced();
            applyThemeBindings(); 
            toastr.success('裁剪已保存并自动绑定至当前主题');
        } else {
            toastr.error('裁剪图片上传失败');
        }
    }
}

// 在放大的头像页面中注入图库和绑定按钮
function injectControlButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const img = zoomedDiv.querySelector('img');
    const src = img.getAttribute('src');
    const avatarId = getAvatarIdFromSrc(src);
    const isUser = isUserAvatar(src);

    // 1. 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'st-panel-btn';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '剪裁图片';
    cropBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        zoomedDiv.click(); 
        await triggerNativeCropPopup(src, avatarId);
    });

    // 2. 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = 'st-panel-btn';
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBinding(avatarId, img.getAttribute('src'), bindBtn);
    });
    updateBindBtnState(bindBtn, avatarId, src); // 初始化状态

    // 3. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'st-panel-btn';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = isUser ? '用户头像图库' : '角色卡面图库';
    galleryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomedDiv.click(); 
        openAltAvatarPanel(avatarId, isUser, src);
    });

    // 注入控制栏最前面
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(galleryBtn, closeBtn);
        controlBar.insertBefore(bindBtn, closeBtn);
        controlBar.insertBefore(cropBtn, closeBtn);
    } else {
        controlBar.appendChild(cropBtn);
        controlBar.appendChild(bindBtn);
        controlBar.appendChild(galleryBtn);
    }
}

// ======================== 环境监控与初始化 ========================

let lastTheme = getCurrentTheme();

setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyThemeBindings(); 
    }

    // 动态添加 头像点击放大开关 到 UI 菜单
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
            #chat .mes .mesAvatarWrapper .avatar img { pointer-events: auto !important; }
        `;
    } else if (pointerStyle) {
        pointerStyle.remove();
    }
}

jQuery(async () => {
    await migrateOldBase64ToFiles();
    applyThemeBindings();
    updateClickZoomState();
    
    // 监听原生上传动作，自动迁移新图
    document.body.addEventListener('change', (e) => {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
            const id = e.target.id;
            if (['add_avatar_button', 'character_replace_file', 'avatar_upload_file', 'group_avatar_button'].includes(id)) {
                
                let oldAvatarId = null;
                const previewImg = document.getElementById('avatar_load_preview') || document.querySelector('#group_avatar_preview .avatar img');
                
                if (previewImg) {
                    const src = previewImg.getAttribute('src');
                    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                        oldAvatarId = getAvatarIdFromSrc(src);
                    } else {
                        oldAvatarId = lastValidAvatarId;
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
                                // 原卡面数据迁移
                                if (newAvatarId !== oldAvatarId && newAvatarId !== 'thumbnail') {
                                    if (extension_settings.altAvatars[oldAvatarId] && extension_settings.altAvatars[oldAvatarId].length > 0) {
                                        extension_settings.altAvatars[newAvatarId] = JSON.parse(JSON.stringify(extension_settings.altAvatars[oldAvatarId]));
                                        delete extension_settings.altAvatars[oldAvatarId];
                                        saveSettingsDebounced();
                                    }
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

    console.log('[AvatarCropper] Successfully Loaded with V2 Entity Files System.');

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
