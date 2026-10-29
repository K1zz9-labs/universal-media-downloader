(function () {
  const blobRegistry = window.__umdBlobRegistry || new Map();
  window.__umdBlobRegistry = blobRegistry;
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;

  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.call(this, obj);
    if (obj instanceof Blob) {
      blobRegistry.set(url, obj);
    }
    return url;
  };

  URL.revokeObjectURL = function (url) {
    if (blobRegistry.has(url)) return;
    return origRevokeObjectURL.call(this, url);
  };

  let activePrompt = null;
  let lastPromptedUrl = '';

  const IGNORE_SELECTORS = [
    '.media-sticker',
    '.media-sticker-wrapper',
    '.is-sticker',
    '.sticker',
    '.emoji',
    '.custom-emoji',
    '.custom-emoji-renderer',
    '.reaction',
    '.reactions',
    '.avatar',
    '.avatar-photo',
    '.chatlist',
    '.sidebar-left',
    '.reply-media'
  ].join(', ');

  function injectStyles() {
    if (document.getElementById('umd-styles')) return;
    const style = document.createElement('style');
    style.id = 'umd-styles';
    style.textContent = `
      .umd-media-prompt {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        background: rgba(20, 20, 24, 0.95);
        color: #fff;
        padding: 12px 16px;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        font-family: 'Segoe UI', Tahoma, sans-serif;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 10px;
        border: 1px solid rgba(255,255,255,0.18);
        backdrop-filter: blur(8px);
      }
      .umd-btn-download {
        background: #3390ec;
        color: #fff;
        border: none;
        padding: 7px 14px;
        border-radius: 6px;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
      }
      .umd-btn-download:hover { background: #2276c9; }
      .umd-btn-download:disabled { background: #555; cursor: wait; }
      .umd-btn-close {
        background: transparent;
        color: #aaa;
        border: none;
        font-size: 16px;
        cursor: pointer;
        padding: 0 4px;
      }
      .umd-btn-close:hover { color: #fff; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function parseTelegramStreamInfo(url) {
    try {
      const streamIndex = url.indexOf('stream/');
      if (streamIndex === -1) return null;
      const encodedJson = url.substring(streamIndex + 7).split('?')[0];
      const decodedJson = decodeURIComponent(encodedJson);
      const data = JSON.parse(decodedJson);
      return {
        size: data.size || null,
        mimeType: data.mimeType || 'video/mp4',
        fileName: data.fileName || `telegram_video_${Date.now()}.mp4`
      };
    } catch (e) {
      return null;
    }
  }

  function isStickerOrEmoji(el, url = '') {
    if (el.matches && el.matches(IGNORE_SELECTORS)) return true;
    if (el.closest && el.closest(IGNORE_SELECTORS)) return true;

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && (rect.width < 120 || rect.height < 120)) return true;

    if (url.includes('stream/')) {
      const info = parseTelegramStreamInfo(url);
      if (info && info.fileName && /^(sticker|animatedsticker|emoji)/i.test(info.fileName)) {
        return true;
      }
    }
    return false;
  }

  function showDownloadPrompt(mediaEl, url, mediaType) {
    if (!url || url === lastPromptedUrl) return;
    lastPromptedUrl = url;

    injectStyles();
    if (activePrompt) activePrompt.remove();

    const streamInfo = mediaType === 'video' ? parseTelegramStreamInfo(url) : null;
    const displayTitle = streamInfo && streamInfo.fileName 
      ? `🎬 ${streamInfo.fileName}` 
      : (mediaType === 'video' ? '🎬 Видео' : '🖼 Фото');

    const box = document.createElement('div');
    box.className = 'umd-media-prompt';
    box.innerHTML = `
      <span style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        <b>${displayTitle}</b>
      </span>
      <button class="umd-btn-download">⬇ Скачать</button>
      <button class="umd-btn-close" title="Закрыть">✕</button>
    `;

    const dlBtn = box.querySelector('.umd-btn-download');
    const closeBtn = box.querySelector('.umd-btn-close');

    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      if (mediaType === 'video') {
        await downloadFullVideo(url, streamInfo, dlBtn, box);
      } else {
        dlBtn.textContent = 'Сохранение...';
        await saveImage(mediaEl, url, dlBtn, box);
      }
    });

    closeBtn.addEventListener('click', () => {
      box.remove();
      activePrompt = null;
    });

    document.body.appendChild(box);
    activePrompt = box;
  }

  async function downloadFullVideo(url, streamInfo, btn, box) {
    const filename = (streamInfo && streamInfo.fileName) ? streamInfo.fileName : `video_${Date.now()}.mp4`;
    const mimeType = (streamInfo && streamInfo.mimeType) ? streamInfo.mimeType : 'video/mp4';

    if (blobRegistry.has(url) && blobRegistry.get(url) instanceof Blob) {
      triggerBrowserDownload(blobRegistry.get(url), filename);
      finishPrompt(btn, box);
      return;
    }

    try {
      const chunks = [];
      let offset = 0;
      let totalSize = streamInfo && streamInfo.size ? streamInfo.size : null;

      while (true) {
        const response = await fetch(url, {
          headers: { 'Range': `bytes=${offset}-` },
          credentials: 'include'
        });

        if (!response.ok && response.status !== 206) {
          throw new Error(`HTTP статус: ${response.status}`);
        }

        if (response.status === 200) {
          const fullBlob = await response.blob();
          triggerBrowserDownload(fullBlob, filename);
          finishPrompt(btn, box);
          return;
        }

        const contentRange = response.headers.get('Content-Range');
        if (contentRange && !totalSize) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1], 10);
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0) break;

        chunks.push(buffer);
        offset += buffer.byteLength;

        if (totalSize) {
          const percent = Math.min(100, Math.round((offset / totalSize) * 100));
          btn.textContent = `Загрузка ${percent}%`;
          if (offset >= totalSize) break;
        } else {
          btn.textContent = `Скачано ${(offset / (1024 * 1024)).toFixed(1)} МБ`;
        }
      }

      const finalBlob = new Blob(chunks, { type: mimeType });
      triggerBrowserDownload(finalBlob, filename);
      finishPrompt(btn, box);
    } catch (err) {
      console.error('Ошибка почанковой загрузки видео:', err);
      btn.textContent = 'Ошибка';
      btn.disabled = false;
    }
  }

  const UMD_DEFAULTS = { resize: true, size: 700, format: 'jpeg', bg: 'white' };

  function getSettings() {
    try {
      const raw = document.documentElement.dataset.umdSettings;
      return Object.assign({}, UMD_DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch (e) {
      return Object.assign({}, UMD_DEFAULTS);
    }
  }

  // Вписывает картинку в квадрат size×size без обрезки, с полями по краям.
  // Уменьшение идёт ступенями (по 2×) — так не появляется «лесенка» и мыло.
  async function fitToSquare(blob, opts) {
    const S = Math.max(16, parseInt(opts.size, 10) || 700);
    const format = opts.format === 'png' ? 'png' : 'jpeg';
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';

    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const srcW = bmp.width, srcH = bmp.height;

    // Уже нужного размера и формата — отдаём оригинал без перекодирования
    if (srcW === S && srcH === S && blob.type === mime) {
      bmp.close && bmp.close();
      return blob;
    }

    const scale = Math.min(S / srcW, S / srcH);
    const dw = Math.max(1, Math.round(srcW * scale));
    const dh = Math.max(1, Math.round(srcH * scale));

    let cur = bmp, cw = srcW, ch = srcH;
    while (cw / 2 >= dw && ch / 2 >= dh) {
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
      const c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = c; cw = nw; ch = nh;
    }

    const out = document.createElement('canvas');
    out.width = S; out.height = S;
    const ctx = out.getContext('2d');
    if (!(format === 'png' && opts.bg === 'transparent')) {
      ctx.fillStyle = opts.bg === 'black' ? '#000000' : '#FFFFFF';
      ctx.fillRect(0, 0, S, S);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const x = Math.floor((S - dw) / 2);
    const y = Math.floor((S - dh) / 2);
    ctx.drawImage(cur, 0, 0, cw, ch, x, y, dw, dh);
    bmp.close && bmp.close();

    return await new Promise((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, 1.0)
    );
  }

  async function getOriginalImageBlob(imgEl, url) {
    if (blobRegistry.has(url) && blobRegistry.get(url) instanceof Blob) {
      return blobRegistry.get(url);
    }
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size > 0) return blob;
      }
    } catch (e) {}

    // Последний вариант — снять картинку с элемента в полном разрешении (PNG, без потерь)
    const canvas = document.createElement('canvas');
    canvas.width = imgEl.naturalWidth || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    canvas.getContext('2d').drawImage(imgEl, 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas toBlob failed'))), 'image/png')
    );
  }

  async function saveImage(imgEl, url, btn, box) {
    try {
      const settings = getSettings();
      let blob = await getOriginalImageBlob(imgEl, url);
      let ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');

      if (settings.resize) {
        blob = await fitToSquare(blob, settings);
        ext = settings.format === 'png' ? 'png' : 'jpg';
      }

      triggerBrowserDownload(blob, `photo_${Date.now()}.${ext}`);
      finishPrompt(btn, box);
    } catch (err) {
      console.error('Ошибка сохранения фото:', err);
      btn.textContent = 'Ошибка';
      btn.disabled = false;
    }
  }

  function triggerBrowserDownload(blob, filename) {
    const freshUrl = origCreateObjectURL.call(URL, blob);
    const a = document.createElement('a');
    a.href = freshUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => origRevokeObjectURL.call(URL, freshUrl), 20000);
  }

  function finishPrompt(btn, box) {
    btn.textContent = '✓ Готово';
    setTimeout(() => {
      if (box) box.remove();
      activePrompt = null;
    }, 1500);
  }

  function checkImage(imgEl) {
    const evaluate = () => {
      if (isStickerOrEmoji(imgEl, imgEl.src)) return;

      const container = imgEl.closest('.media-container, .media-viewer-aspecter, .ckin__player');
      if (container && container.querySelector('video')) return;
      if (imgEl.parentElement && imgEl.parentElement.querySelector('video')) return;

      const src = imgEl.currentSrc || imgEl.src;
      if (!src) return;
      const w = imgEl.naturalWidth || imgEl.clientWidth;
      const h = imgEl.naturalHeight || imgEl.clientHeight;
      if (w >= 300 && h >= 300 && src.startsWith('blob:')) {
        showDownloadPrompt(imgEl, src, 'image');
      }
    };
    if (imgEl.complete) evaluate();
    else imgEl.addEventListener('load', evaluate, { once: true });
  }

  function checkVideo(videoEl) {
    const evaluate = () => {
      const rawSrc = videoEl.getAttribute('src') || videoEl.currentSrc || videoEl.src || (videoEl.querySelector('source')?.src);
      if (!rawSrc) return;
      const fullUrl = new URL(rawSrc, document.baseURI).href;

      if (isStickerOrEmoji(videoEl, fullUrl)) return;

      showDownloadPrompt(videoEl, fullUrl, 'video');
    };

    if (!videoEl.dataset.umdAttached) {
      videoEl.dataset.umdAttached = 'true';
      videoEl.addEventListener('play', evaluate);
      videoEl.addEventListener('loadedmetadata', evaluate);
      videoEl.addEventListener('mouseenter', evaluate);
    }

    if (videoEl.getAttribute('src') || videoEl.currentSrc) {
      evaluate();
    }
  }

  const startObserving = () => {
    document.querySelectorAll('video').forEach(checkVideo);
    document.querySelectorAll('img').forEach(checkImage);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'src') {
          if (m.target.tagName === 'VIDEO') checkVideo(m.target);
          else if (m.target.tagName === 'IMG') checkImage(m.target);
        }
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'VIDEO') checkVideo(node);
          else if (node.tagName === 'IMG') checkImage(node);
          else if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach(checkVideo);
            node.querySelectorAll('img').forEach(checkImage);
          }
        });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
})();