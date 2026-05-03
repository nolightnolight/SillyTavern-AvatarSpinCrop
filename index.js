import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

if (!extension_settings.avatarCroppedImages) {
    extension_settings.avatarCroppedImages = {};
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

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

async function getBase64FromUrl(url) {
    const data = await fetch(url);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob); 
        reader.onloadend = () => {
            resolve(reader.result);
        }
    });
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

let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars(); 
    }
}, 1000);

async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    const base64Original = await getBase64FromUrl(imgSrc);

    // 1. 去掉 cropAspect: 1 限制，解绑 1:1 比例，激活四侧边框的自由拉伸
    // 注意这里没有用 await，是为了让代码继续往下走去修改 DOM
    const popupPromise = callGenericPopup(
        '', 
        POPUP_TYPE.CROP, 
        '', 
        { cropImage: base64Original } 
    );

    // 2. 核心魔法：轮询寻找弹窗中的 Cropper 实例，找到后修改内部模式
    let attempts = 0;
    const hackCropperInterval = setInterval(() => {
        // Cropper.js 会把原始 img 加上 cropper-hidden 类
        const img = document.querySelector('#dialogue_popup img.cropper-hidden');
        if (img && img.cropper) {
            // 将鼠标操作模式改为 'move'：这样在选取框外部点击拖拽时，就是平移图片，而不是画新框！
            img.cropper.setDragMode('move');
            clearInterval(hackCropperInterval);
        }
        attempts++;
        if (attempts > 50) clearInterval(hackCropperInterval); // 防止死循环（5秒后放弃）
    }, 100);

    // 3. 等待用户完成裁剪点击“确定”
    const croppedImageBase64 = await popupPromise;
    clearInterval(hackCropperInterval); // 用户操作完毕，清理定时器

    if (croppedImageBase64) {
        const theme = getCurrentTheme(); 
        if (!extension_settings.avatarCroppedImages[theme]) {
            extension_settings.avatarCroppedImages[theme] = {};
        }

        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        
        toastr.success('头像已保存');
    }
}

function injectCropButton(zoomedDiv) {
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
    if (closeBtn) {
        controlBar.insertBefore(btn, closeBtn);
    } else {
        controlBar.appendChild(btn);
    }
}

jQuery(async () => {
    applyCroppedAvatars();

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) {
                        injectCropButton(node);
                    } else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectCropButton(zoomed);
                    }
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
});
