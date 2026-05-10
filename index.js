import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// ===== 初始化数据结构 =====
// 全局用户图库 (所有Persona共享)
if (!extension_settings.stGlobalUserGallery) extension_settings.stGlobalUserGallery = [];
// 角色独立图库 (Key为角色名称)
if (!extension_settings.stCharGalleries) extension_settings.stCharGalleries = {};
// 绑定数据 (结构: { themeName: { charOrUserName: "base64..." } })
if (!extension_settings.stThemeBinds) extension_settings.stThemeBinds = {};

// 记录当前点击放大的头像上下文
let activeZoomContext = { isUser: false, name: '' };

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

// 监听聊天框头像点击，记录上下文
$(document).on('click', '#chat .mes .avatar img', function() {
    const mesBlock = $(this).closest('.mes');
    activeZoomContext.isUser = mesBlock.attr('is_user') === 'true';
    // is_user为真时使用 "User"，否则使用角色的真实名称
    activeZoomContext.name = activeZoomContext.isUser ? "User" : (mesBlock.attr('ch_name') || '');
});

// ===== 基础工具函数 =====
async function resizeImageToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 800; 
                let width = img.width, height = img.height;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width; width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height; height = MAX_SIZE;
                }
                canvas.width = width; canvas.height = height;
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

// ===== 触发原生上传流程 =====
async function triggerNativeUpload(base64Image, isUser) {
    toastr.info("正在应用并上传新头像...");
    const blob = await (await fetch(base64Image)).blob();
    const file = new File([blob], `avatar_${Date.now()}.png`, { type: 'image/png' });
    
    // 使用 DataTransfer 伪造用户文件选择
    const dt = new DataTransfer();
    dt.items.add(file);

    let inputElement;
    if (isUser) {
        inputElement = document.getElementById('avatar_upload_file');
    } else {
        // 角色界面通常有用于替换当前角色的 input
        inputElement = document.getElementById('character_replace_file') || document.getElementById('add_avatar_button_upload');
    }

    if (inputElement) {
        inputElement.files = dt.files;
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
        toastr.success("头像已成功替换");
    } else {
        toastr.error("未找到SillyTavern原生上传接口");
    }
}

// ===== 绑定与CSS注入引擎 =====
// 仅针对聊天框 .mes 内的头像生效
function applyThemeBinds() {
    const theme = getCurrentTheme();
    const binds = extension_settings.stThemeBinds[theme] || {};
    let cssString = '';

    for (const [name, base64] of Object.entries(binds)) {
        if (!base64) continue;
        
        // 针对User和Char分别编写精准的作用域选择器
        if (name === "User") {
            cssString += `
                #chat .mes[is_user="true"] .avatar img {
                    content: url("${base64}") !important;
                    object-fit: cover !important;
                }
            `;
        } else {
            // 转义角色名字中的特殊字符
            const safeName = name.replace(/"/g, '\\"');
            cssString += `
                #chat .mes[ch_name="${safeName}"] .avatar img {
                    content: url("${base64}") !important;
                    object-fit: cover !important;
                }
            `;
        }
    }

    let styleTag = document.getElementById('st-avatar-bind-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-avatar-bind-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function clearBindData(base64ImageToRemove) {
    // 遍历所有主题，如果绑定的图片是这张要删除的，则清除绑定
    for (const theme of Object.keys(extension_settings.stThemeBinds)) {
        for (const name of Object.keys(extension_settings.stThemeBinds[theme])) {
            if (extension_settings.stThemeBinds[theme][name] === base64ImageToRemove) {
                delete extension_settings.stThemeBinds[theme][name];
            }
        }
    }
    saveSettingsDebounced();
    applyThemeBinds();
}

// ===== 图库弹窗与管理 =====
async function openGalleryPanel(context) {
    const isUser = context.isUser;
    const name = context.name;
    
    // 获取对应图库数据
    let galleryArray = [];
    if (isUser) {
        galleryArray = extension_settings.stGlobalUserGallery;
    } else {
        if (!extension_settings.stCharGalleries[name]) extension_settings.stCharGalleries[name] = [];
        galleryArray = extension_settings.stCharGalleries[name];
    }
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '用户图库' : `角色图库: ${name}`}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="添加图片"><i class="fa-solid fa-plus"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理/删除"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-delete-confirm" style="display:none; color:#ff4444;"><i class="fa-solid fa-trash-can"></i></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    // 弹窗本身不带确定按钮，点击图片即触发
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
        
        function updateDeleteConfirmBtn() {
            btnDeleteConfirm.title = `确认删除 (${itemsToDelete.size})`;
        }

        function renderGrid() {
            grid.innerHTML = '';
            
            galleryArray.forEach((b64, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item';
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${b64}">`;
                itemDiv.onclick = async (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        if (itemsToDelete.has(index)) {
                            itemsToDelete.delete(index); itemDiv.classList.remove('to-delete');
                        } else {
                            itemsToDelete.add(index); itemDiv.classList.add('to-delete');
                        }
                        updateDeleteConfirmBtn();
                    } else { 
                        // 点击图片，触发原生上传并关闭弹窗
                        document.querySelector('#dialogue_popup .popup-controls .menu_button').click();
                        await triggerNativeUpload(b64, isUser);
                    }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '退出管理';
                btnUpload.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                itemsToDelete.clear();
                updateDeleteConfirmBtn();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理/删除';
                btnUpload.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const confirm = await callGenericPopup(`是否确认删除选中的 ${itemsToDelete.size} 张图片？相关绑定数据将被清空。`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            indexes.forEach((index) => {
                const b64ToRemove = galleryArray[index];
                galleryArray.splice(index, 1);
                clearBindData(b64ToRemove); // 清空被删图片的绑定
            });

            saveSettingsDebounced();
            
            // 如果图库删空了，恢复系统默认头像
            if (galleryArray.length === 0) {
                toastr.warning("图库已空，正在恢复默认头像...");
                const defaultImgPath = isUser ? '/img/user.png' : '/img/ai4.png';
                const defaultB64 = await getBase64FromUrl(window.location.origin + defaultImgPath);
                await triggerNativeUpload(defaultB64, isUser);
            }

            btnManage.click(); 
            toastr.success('已成功删除');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            toastr.info(`正在处理 ${files.length} 张图片`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                galleryArray.unshift(b64); // 新图放在最前面
            }
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
        };
        
        renderGrid();
    }, 100);
}

// ===== 控制栏 UI 注入与事件处理 =====
function injectControlButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const context = { ...activeZoomContext }; // 捕获当前上下文
    const theme = getCurrentTheme();
    
    // 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'st-custom-btn';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = '打开图库';

    // 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = 'st-custom-btn';
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = '绑定到当前美化主题';

    // 裁剪按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'st-custom-btn';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '剪裁头像 (局部生效)';

    // 初始化绑定状态UI
    const currentThemeBinds = extension_settings.stThemeBinds[theme] || {};
    if (currentThemeBinds[context.name]) {
        bindBtn.classList.add('is-bound');
    }

    // 事件：点击图库
    galleryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomedDiv.click(); // 关闭放大预览
        openGalleryPanel(context);
    });

    // 事件：点击裁剪
    cropBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        const img = zoomedDiv.querySelector('img');
        if (img) {
            zoomedDiv.click(); 
            const base64Original = await getBase64FromUrl(img.src);
            const croppedImageBase64 = await callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });
            
            if (croppedImageBase64) {
                // 裁剪后自动绑定
                if (!extension_settings.stThemeBinds[theme]) extension_settings.stThemeBinds[theme] = {};
                extension_settings.stThemeBinds[theme][context.name] = croppedImageBase64;
                saveSettingsDebounced();
                applyThemeBinds(); 
                toastr.success('头像已裁剪并自动绑定至当前主题');
            }
        }
    });

    // 事件：手动绑定/解绑
    bindBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!extension_settings.stThemeBinds[theme]) extension_settings.stThemeBinds[theme] = {};

        if (bindBtn.classList.contains('is-bound')) {
            // 解除绑定
            delete extension_settings.stThemeBinds[theme][context.name];
            bindBtn.classList.remove('is-bound');
            toastr.info('已解除当前主题的头像绑定，恢复默认。');
        } else {
            // 手动绑定：获取当前显示的图片Base64进行绑定
            const img = zoomedDiv.querySelector('img');
            if (img) {
                const base64Current = await getBase64FromUrl(img.src);
                extension_settings.stThemeBinds[theme][context.name] = base64Current;
                bindBtn.classList.add('is-bound');
                toastr.success('已将当前头像绑定至该主题。');
            }
        }
        saveSettingsDebounced();
        applyThemeBinds();
    });

    // 将按钮按顺序插入控制条左侧（Close按钮之前）
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(galleryBtn, closeBtn);
        controlBar.insertBefore(cropBtn, closeBtn);
        controlBar.insertBefore(bindBtn, closeBtn);
    }
}

// ===== 主题切换监控与初始化 =====
let lastTheme = getCurrentTheme();

setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyThemeBinds(); // 切换主题时刷新绑定显示
    }
}, 1000);

jQuery(async () => {
    applyThemeBinds();
    console.log('[AvatarGallery & Binder] Successfully Loaded.');

    // 监控放大头像 DOM 的生成
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) {
                        injectControlButtons(node);
                    } else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectControlButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
