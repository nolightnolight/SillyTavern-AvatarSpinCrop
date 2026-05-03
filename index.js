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
    const theme = localStorage.getItem('theme') || 'default';
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

let lastTheme = localStorage.getItem('theme');
setInterval(() => {
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars();
    }
}, 1000);

async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    const base64Original = await getBase64FromUrl(imgSrc);

    // 第一个参数设为 ''，去除弹窗标题
    const croppedImageBase64 = await callGenericPopup(
        '', 
        POPUP_TYPE.CROP, 
        '', 
        { cropAspect: 1, cropImage: base64Original }
    );

    if (croppedImageBase64) {
        const theme = localStorage.getItem('theme') || 'default';
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

    // 寻找控制栏
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
            zoomedDiv.click(); // 关闭放大预览
            await triggerNativeCropPopup(img.src);
        }
    });

    // 插入到控制栏中（将其放在关闭按钮前面，或者直接添加到末尾）
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
