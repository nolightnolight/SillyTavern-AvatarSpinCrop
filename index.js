import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
if (extension_settings.avatarClickZoomEnabled === undefined) extension_settings.avatarClickZoomEnabled = false;
if (!extension_settings.avatarCroppedImages) extension_settings.avatarCroppedImages = {};
if (!extension_settings.altAvatars) extension_settings.altAvatars = {};

// 获取当前主题
function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

// 识别当前打开的放大头像是 User 还是 Char，并提取唯一 ID
function getAvatarInfoFromSrc(src) {
    if (!src) return null;
    const decoded = decodeURIComponent(src);
    const isUser = decoded.includes('User Avatars');
    let id = null;
    
    if (isUser) {
        // user使用全局统一图库
        id = 'GLOBAL_USER';
    } else {
        // char使用独立图库，提取文件名
        let cleanSrc = decoded.split('?')[0];
        const parts = cleanSrc.split('/');
        id = parts[parts.length - 1];
    }
    return { id, isUser, src: decoded };
}

// 后端交互：上传实体文件至服务器 (返回在服务器中的相对路径)
async function uploadServerImage(base64Str, filenamePrefix) {
    const b64Data = base64Str.includes(',') ? base64Str.split(',')[1] : base64Str;
    const filename = `${filenamePrefix.replace(/\.[^/.]+$/, "")}_${Date.now()}.png`;

    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': window['csrf_token']
            },
            body: JSON.stringify({
                image: b64Data,
                format: 'png',
                ch_name: 'avatar_gallery', // 文件将被储存在 data/default-user/user/images/avatar_gallery/ 目录下
                filename: filename
            })
        });

        if (response.ok) {
            const data = await response.json();
            return data.path; // 返回相对路径供前端调用
        }
    } catch (e) {
        console.error("Avatar Ext: Upload failed", e);
    }
    return null;
}

// 后端交互：从服务器删除实体文件
async function deleteServerImage(path) {
    if (!path || path.startsWith('data:')) return;
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': window['csrf_token']
            },
            body: JSON.stringify({ path: path })
        });
    } catch (e) {
        console.error("Avatar Ext: Delete failed", e);
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
                resolve(canvas.toDataURL('image/png', 0.9)); 
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

// ======================== CSS 渲染引擎 (整合) ========================

function applyAvatarOverrides() {
    let cssString = '';
    const theme = getCurrentTheme();

    const allIds = new Set([
        ...Object.keys(extension_settings.altAvatars || {}),
        ...Object.keys(extension_settings.avatarCroppedImages?.[theme] || {})
    ]);

    for (const id of allIds) {
        if (id === 'thumbnail') continue;

        let finalPath = null;

        // 1. 优先度最高：当前主题的绑定
        if (extension_settings.avatarCroppedImages?.[theme]?.[id]) {
            finalPath = extension_settings.avatarCroppedImages[theme][id];
        } 
        // 2. 其次：图库中选择的应用图片
        else if (extension_settings.altAvatars?.[id]?.selected !== null) {
            const selIdx = extension_settings.altAvatars[id].selected;
            if (extension_settings.altAvatars[id].images[selIdx]) {
                finalPath = extension_settings.altAvatars[id].images[selIdx];
            }
        }

        if (finalPath) {
            if (id === 'GLOBAL_USER') {
                cssString += `
                    .mes[is_user="true"] .avatar img,
                    #user_avatar_block .selected .avatar img,
                    .zoomed_avatar img[src*="User Avatars"] {
                        content: url("${finalPath}") !important;
                        object-fit: cover !important;
                    }
                `;
            } else {
                const escapedId = id.replace(/"/g, '\\"');
                const encodedId = encodeURIComponent(id).replace(/"/g, '\\"');
                cssString += `
                    .avatar img[src*="${escapedId}"],
                    .avatar img[src*="${encodedId}"],
                    #avatar_load_preview[src*="${escapedId}"],
                    #avatar_load_preview[src*="${encodedId}"],
                    .zoomed_avatar img[src*="${escapedId}"],
                    .zoomed_avatar img[src*="${encodedId}"] {
                        content: url("${finalPath}") !important;
                        object-fit: cover !important;
                    }
                `;
            }
        }
    }

    let styleTag = document.getElementById('custom-avatar-override-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-override-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

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

// ======================== 图库与控制面板 ========================

async function openAltAvatarPanel(avatarInfo) {
    if (!avatarInfo) return toastr.error('无法获取头像信息');
    
    const id = avatarInfo.id;
    if (!extension_settings.altAvatars[id]) {
        extension_settings.altAvatars[id] = { selected: null, images: [] };
    }
    const data = extension_settings.altAvatars[id];
    const isChar = !avatarInfo.isUser;
    
    // 生成头部 HTML (Char 图库支持导出导入)
    const exportImportHtml = isChar ? `
        <div class="menu_button menu_button_icon margin0" id="btn-alt-export" title="导出打包"><i class="fa-solid fa-file-export"></i></div>
        <div class="menu_button menu_button_icon margin0" id="btn-alt-import" title="导入打包"><i class="fa-solid fa-file-import"></i></div>
    ` : '';

    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isChar ? '角色图库' : 'User 图库 (全局)'}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    ${exportImportHtml}
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理列表"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button margin0" id="btn-alt-delete-confirm" style="display:none; padding: 0 10px;">
                        <i class="fa-solid fa-trash-can"></i> <span class="delete-text-confirm">确认删除</span>
                    </div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;
    
    let tempSelected = data.selected; 

    // 只有在按下 确认(OK) 时，才会真正应用修改的 selection
    callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true }).then((confirm) => {
        if (confirm) {
            if (data.selected !== tempSelected) {
                data.selected = tempSelected;
                saveSettingsDebounced();
                applyAvatarOverrides(); 
            }
            toastr.success('已应用头像更改');
        }
    });
    
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
            
            // 原图
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (tempSelected === null ? ' selected' : '');
            origDiv.innerHTML = `<img src="${avatarInfo.src}" title="默认/原图" onerror="this.src='img/ai4.png'">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            // 图库图片
            data.images.forEach((path, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (tempSelected === index ? ' selected' : '');
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${path}">`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) { e.stopPropagation(); toggleDeleteMark(index, itemDiv); } 
                    else { selectAvatar(index); }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        function selectAvatar(index) {
            if (isDeleteMode) return;
            tempSelected = index;
            renderGrid();
        }

        function toggleDeleteMark(index, element) {
            if (itemsToDelete.has(index)) { itemsToDelete.delete(index); element.classList.remove('to-delete'); } 
            else { itemsToDelete.add(index); element.classList.add('to-delete'); }
            btnDeleteConfirm.querySelector('.delete-text-confirm').innerText = `确认删除 (${itemsToDelete.size})`;
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '退出管理';
                btnUpload.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                if(isChar) document.getElementById('btn-alt-export').style.display = document.getElementById('btn-alt-import').style.display = 'none';
                itemsToDelete.clear();
                btnDeleteConfirm.querySelector('.delete-text-confirm').innerText = `确认删除 (0)`;
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理列表';
                btnUpload.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
                if(isChar) document.getElementById('btn-alt-export').style.display = document.getElementById('btn-alt-import').style.display = 'flex';
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();

            const confirm = await callGenericPopup(`是否确认从服务器物理删除选中的 ${itemsToDelete.size} 张图片？（此操作不可逆，将自动清空关联的绑定）`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            toastr.info("正在删除并清理绑定数据...");
            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            
            for (const index of indexes) {
                const deletedPath = data.images[index];

                // 物理删除服务器上的文件
                await deleteServerImage(deletedPath);

                // 修正图库选择序号
                if (data.selected === index) data.selected = null;
                else if (data.selected > index) data.selected -= 1;
                
                if (tempSelected === index) tempSelected = null;
                else if (tempSelected > index) tempSelected -= 1;
                
                // 清理所有美化主题中使用了这张图的“绑定”记录
                for (const t in extension_settings.avatarCroppedImages) {
                    if (extension_settings.avatarCroppedImages[t] && extension_settings.avatarCroppedImages[t][id] === deletedPath) {
                        delete extension_settings.avatarCroppedImages[t][id];
                    }
                }

                data.images.splice(index, 1);
            }

            saveSettingsDebounced();
            applyAvatarOverrides();
            btnManage.click(); 
            toastr.success('已成功删除');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在处理并上传 ${files.length} 张图片`);
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const serverPath = await uploadServerImage(b64, id);
                if (serverPath) data.images.push(serverPath);
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('所有图片上传完成');
        };

        // 导出导入功能 (仅 Char)
        if (isChar) {
            document.getElementById('btn-alt-export').onclick = async () => {
                if (data.images.length === 0) return toastr.warning("图库为空");
                toastr.info('正在获取文件并打包导出...');
                const pack = [];
                for (const path of data.images) {
                    try { pack.push(await getBase64FromUrl(path)); } catch(e) {}
                }
                const blob = new Blob([JSON.stringify(pack)], {type: 'application/json'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `${id}_gallery.json`; a.click();
                toastr.success('导出成功');
            };

            document.getElementById('btn-alt-import').onclick = () => {
                const input = document.createElement('input');
                input.type = 'file'; input.accept = 'application/json';
                input.onchange = (e) => {
                    const file = e.target.files[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        try {
                            const pack = JSON.parse(ev.target.result);
                            if (!Array.isArray(pack)) throw new Error();
                            toastr.info(`正在导入 ${pack.length} 张图片...`);
                            for (const b64 of pack) {
                                const path = await uploadServerImage(b64, id + "_import");
                                if (path) data.images.push(path);
                            }
                            saveSettingsDebounced(); renderGrid();
                            toastr.success('导入完成');
                        } catch(err) { toastr.error('导入失败，文件格式不正确'); }
                    };
                    reader.readAsText(file);
                };
                input.click();
            };
        }
        
        renderGrid();
    }, 100);
}

// ======================== 功能栏注入与绑定逻辑 ========================

// 绑定功能：切换图片的主题绑定状态
function toggleBinding(avatarInfo, btnElement) {
    const theme = getCurrentTheme();
    if (!extension_settings.avatarCroppedImages[theme]) extension_settings.avatarCroppedImages[theme] = {};

    const isBound = !!extension_settings.avatarCroppedImages[theme][avatarInfo.id];

    if (isBound) {
        // 解除绑定
        delete extension_settings.avatarCroppedImages[theme][avatarInfo.id];
        toastr.success('已解除绑定，恢复默认设置');
    } else {
        // 绑定当前显示在头像框上的图片
        let activePath = avatarInfo.src; // 默认为原图
        const gallery = extension_settings.altAvatars[avatarInfo.id];
        if (gallery && gallery.selected !== null && gallery.images[gallery.selected]) {
            activePath = gallery.images[gallery.selected]; // 如果图库有选择则为图库图片
        }
        extension_settings.avatarCroppedImages[theme][avatarInfo.id] = activePath;
        toastr.success('已将当前头像绑定至该主题');
    }
    
    saveSettingsDebounced();
    applyAvatarOverrides();
    updateBindButtonState(btnElement, avatarInfo);
}

function updateBindButtonState(btn, avatarInfo) {
    const theme = getCurrentTheme();
    const isBound = extension_settings.avatarCroppedImages[theme] && extension_settings.avatarCroppedImages[theme][avatarInfo.id];
    if (isBound) btn.classList.add('bound');
    else btn.classList.remove('bound');
}

// 触发原生剪裁弹窗
async function triggerNativeCropPopup(avatarInfo) {
    let base64Original;
    const gallery = extension_settings.altAvatars[avatarInfo.id];
    if (gallery && gallery.selected !== null && gallery.images[gallery.selected]) {
        base64Original = await getBase64FromUrl(gallery.images[gallery.selected]);
    } else {
        base64Original = await getBase64FromUrl(avatarInfo.src);
    }

    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    setTimeout(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            cropperImg.cropper.setDragMode('move');
            cropperImg.cropper.options.wheelZoomRatio = 0.05;
        }
    }, 150);

    const croppedImageBase64 = await cropPromise;

    if (croppedImageBase64) {
        toastr.info("正在上传剪裁后的头像...");
        const serverPath = await uploadServerImage(croppedImageBase64, avatarInfo.id + "_crop");
        if (serverPath) {
            const theme = getCurrentTheme(); 
            if (!extension_settings.avatarCroppedImages[theme]) extension_settings.avatarCroppedImages[theme] = {};
            
            // 自动绑定并激活绿灯
            extension_settings.avatarCroppedImages[theme][avatarInfo.id] = serverPath;
            saveSettingsDebounced();
            applyAvatarOverrides(); 
            toastr.success('头像剪裁已保存，并自动绑定到当前主题');
        }
    }
}

// 注入功能按钮到放大弹窗控制栏
function injectZoomedControls(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-avatar-controls-container')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const img = zoomedDiv.querySelector('img');
    const originalSrc = img ? img.getAttribute('src') : null;
    const avatarInfo = getAvatarInfoFromSrc(originalSrc);

    if (!avatarInfo) return;

    const container = document.createElement('div');
    container.id = 'st-avatar-controls-container';

    // 1. 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.className = 'st-btn';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '剪裁头像';
    cropBtn.onclick = async (e) => { e.stopPropagation(); zoomedDiv.click(); await triggerNativeCropPopup(avatarInfo); };

    // 2. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.className = 'st-btn';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = avatarInfo.isUser ? 'User 专属图库' : 'Char 图库';
    galleryBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); openAltAvatarPanel(avatarInfo); };

    // 3. 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = 'st-btn';
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = '将当前显示的图片绑定至本主题';
    updateBindButtonState(bindBtn, avatarInfo);
    bindBtn.onclick = (e) => { e.stopPropagation(); toggleBinding(avatarInfo, bindBtn); };

    container.appendChild(cropBtn);
    container.appendChild(galleryBtn);
    container.appendChild(bindBtn);

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(container, closeBtn);
    else controlBar.appendChild(container);
}

let lastTheme = getCurrentTheme();

setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyAvatarOverrides(); 
    }

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

jQuery(async () => {
    applyAvatarOverrides();
    updateClickZoomState();

    console.log('[AvatarCropper] Successfully Loaded.');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectZoomedControls(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectZoomedControls(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
