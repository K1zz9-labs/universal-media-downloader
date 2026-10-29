let allMedia = [];
let currentFilter = 'all';
let selectedDate = 'all';
let newestFirst = true;
let currentTabId = null;

const UMD_DEFAULTS = { resize: true, size: 700, format: 'jpeg', bg: 'white' };
let settings = Object.assign({}, UMD_DEFAULTS);

async function loadSettings() {
  const r = await chrome.storage.local.get('umdSettings');
  settings = Object.assign({}, UMD_DEFAULTS, (r && r.umdSettings) || {});
}

function saveSettings() {
  chrome.storage.local.set({ umdSettings: settings });
}

// Вписывает картинку в квадрат size×size без обрезки (поля по краям).
// Уменьшение ступенями по 2× + сглаживание 'high' — максимум чёткости.
async function fitToSquare(blob, opts) {
  const S = Math.max(16, parseInt(opts.size, 10) || 700);
  const format = opts.format === 'png' ? 'png' : 'jpeg';
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';

  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const srcW = bmp.width, srcH = bmp.height;

  if (srcW === S && srcH === S && blob.type === mime) {
    bmp.close();
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
  ctx.drawImage(cur, 0, 0, cw, ch, Math.floor((S - dw) / 2), Math.floor((S - dh) / 2), dw, dh);
  bmp.close();

  return await new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, 1.0)
  );
}

function outputFilename(item) {
  if (item.type !== 'image' || !settings.resize) return item.filename;
  const ext = settings.format === 'png' ? 'png' : 'jpg';
  return item.filename.replace(/\.[a-zA-Z0-9]+$/, '') + '.' + ext;
}

// Получает файл: сначала со страницы (кэш blob / fetch), потом из попапа (обходит CORS
// за счёт host_permissions). Для фото — приводит к квадрату, если включено.
async function getItemBlob(item) {
  let blob = null;

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      world: 'MAIN',
      func: extractMediaAsBase64InPage,
      args: [item.url, item.type, item.size, item.mimeType]
    });
    if (res && res[0] && res[0].result) {
      const r = res[0].result;
      const bytes = base64ToUint8Array(r);
      const mt = (r.match(/^data:([^;,]+)/) || [])[1] || item.mimeType || 'application/octet-stream';
      if (bytes.byteLength > 0) blob = new Blob([bytes], { type: mt });
    }
  } catch (e) {
    console.warn('Page extract failed:', e);
  }

  if (!blob && /^https?:/i.test(item.url)) {
    try {
      const r = await fetch(item.url);
      if (r.ok) {
        const b = await r.blob();
        if (b.size > 0) blob = b;
      }
    } catch (e) {}
  }

  if (!blob) return null;

  if (item.type === 'image' && settings.resize) {
    blob = await fitToSquare(blob, settings);
  }
  return blob;
}

class NativeZip {
  constructor() {
    this.files = [];
    this.usedNames = new Set();
    this.crcTable = this.makeCrcTable();
  }

  makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  }

  crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ this.crcTable[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  addFile(folder, filename, uint8Data) {
    const cleanFolder = (folder || 'Media').replace(/[\\/:*?"<>|]/g, '_').trim();
    const cleanName = (filename || 'file.bin').replace(/[\\/:*?"<>|]/g, '_').trim();
    let fullPath = `${cleanFolder}/${cleanName}`;

    let counter = 1;
    while (this.usedNames.has(fullPath)) {
      const dotIdx = cleanName.lastIndexOf('.');
      if (dotIdx !== -1) {
        fullPath = `${cleanFolder}/${cleanName.slice(0, dotIdx)}_${counter++}${cleanName.slice(dotIdx)}`;
      } else {
        fullPath = `${cleanFolder}/${cleanName}_${counter++}`;
      }
    }
    this.usedNames.add(fullPath);

    const nameBytes = new TextEncoder().encode(fullPath);
    const crc = this.crc32(uint8Data);
    this.files.push({ nameBytes, data: uint8Data, crc });
  }

  generateBlob() {
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const file of this.files) {
      const size = file.data.byteLength;
      const nameLen = file.nameBytes.byteLength;

      const lfh = new ArrayBuffer(30);
      const lfhView = new DataView(lfh);
      lfhView.setUint32(0, 0x04034b50, true);
      lfhView.setUint16(4, 20, true);
      lfhView.setUint16(6, 0x0800, true);
      lfhView.setUint16(8, 0, true);
      lfhView.setUint16(10, 0, true);
      lfhView.setUint16(12, 0x0021, true);
      lfhView.setUint32(14, file.crc, true);
      lfhView.setUint32(18, size, true);
      lfhView.setUint32(22, size, true);
      lfhView.setUint16(26, nameLen, true);
      lfhView.setUint16(28, 0, true);

      parts.push(new Uint8Array(lfh), file.nameBytes, file.data);

      const cdh = new ArrayBuffer(46);
      const cdhView = new DataView(cdh);
      cdhView.setUint32(0, 0x02014b50, true);
      cdhView.setUint16(4, 20, true);
      cdhView.setUint16(6, 20, true);
      cdhView.setUint16(8, 0x0800, true);
      cdhView.setUint16(10, 0, true);
      cdhView.setUint16(12, 0, true);
      cdhView.setUint16(14, 0x0021, true);
      cdhView.setUint32(16, file.crc, true);
      cdhView.setUint32(20, size, true);
      cdhView.setUint32(24, size, true);
      cdhView.setUint16(28, nameLen, true);
      cdhView.setUint16(30, 0, true);
      cdhView.setUint16(32, 0, true);
      cdhView.setUint16(34, 0, true);
      cdhView.setUint16(36, 0, true);
      cdhView.setUint32(38, 0, true);
      cdhView.setUint32(42, offset, true);

      centralDir.push(new Uint8Array(cdh), file.nameBytes);
      offset += 30 + nameLen + size;
    }

    let cdSize = 0;
    for (const part of centralDir) {
      parts.push(part);
      cdSize += part.byteLength;
    }

    const eocd = new ArrayBuffer(22);
    const eocdView = new DataView(eocd);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, this.files.length, true);
    eocdView.setUint16(10, this.files.length, true);
    eocdView.setUint32(12, cdSize, true);
    eocdView.setUint32(16, offset, true);
    eocdView.setUint16(20, 0, true);

    parts.push(new Uint8Array(eocd));
    return new Blob(parts, { type: 'application/zip' });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  initSettingsUI();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || tab.url.startsWith('edge://') || tab.url.startsWith('chrome://')) {
    document.getElementById('media-list').innerHTML = '<div class="empty">На системных страницах скачивание недоступно.</div>';
    return;
  }

  currentTabId = tab.id;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: scanPageWithDatesAndMedia
    });

    const mediaMap = new Map();
    results.forEach(frame => {
      if (frame.result) {
        frame.result.forEach(item => {
          if (!mediaMap.has(item.url)) {
            mediaMap.set(item.url, item);
          }
        });
      }
    });

    allMedia = Array.from(mediaMap.values());
    updateDateSelectOptions();
    renderList();

    if (allMedia.length > 0) {
      document.getElementById('download-zip').disabled = false;
    }
  } catch (err) {
    document.getElementById('media-list').innerHTML = `<div class="empty">Ошибка: ${err.message}</div>`;
  }

  function updateDateSelectOptions() {
    const select = document.getElementById('date-select');
    const dates = [...new Set(allMedia.map(item => item.date || 'Общие медиа'))];
    
    select.innerHTML = '<option value="all">📅 Все даты</option>';
    dates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = `📅 ${d}`;
      select.appendChild(opt);
    });
  }

  document.getElementById('date-select').addEventListener('change', (e) => {
    selectedDate = e.target.value;
    renderList();
  });

  document.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentFilter = e.target.getAttribute('data-filter');
      renderList();
    });
  });

  const sortBtn = document.getElementById('sort-btn');
  sortBtn.addEventListener('click', () => {
    newestFirst = !newestFirst;
    sortBtn.textContent = newestFirst ? 'Сначала новые ↓' : 'Сначала старые ↑';
    renderList();
  });

  document.getElementById('download-zip').addEventListener('click', async () => {
    const filtered = getFilteredMedia();
    if (filtered.length === 0) return;

    const btn = document.getElementById('download-zip');
    btn.disabled = true;
    const originalText = btn.innerHTML;

    try {
      const zip = new NativeZip();
      let addedCount = 0;

      for (let i = 0; i < filtered.length; i++) {
        const item = filtered[i];
        btn.textContent = `📦 Сборка: ${i + 1} из ${filtered.length}...`;

        try {
          const blob = await getItemBlob(item);
          if (blob && blob.size > 0) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            zip.addFile(item.date || 'Без_даты', outputFilename(item), bytes);
            addedCount++;
          }
        } catch (itemErr) {
          console.warn('Пропущен файл:', item.filename, itemErr);
        }
      }

      if (addedCount > 0) {
        btn.textContent = '💾 Сохранение ZIP...';
        const zipBlob = zip.generateBlob();
        const zipUrl = URL.createObjectURL(zipBlob);

        chrome.downloads.download({
          url: zipUrl,
          filename: `Telegram_Media_${Date.now()}.zip`,
          conflictAction: 'uniquify'
        });

        setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
      } else {
        alert('Не удалось прочитать файлы со страницы.');
      }
    } catch (zipErr) {
      console.error('Ошибка создания ZIP:', zipErr);
      alert('Ошибка при сборке ZIP: ' + zipErr.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });
});

function getFilteredMedia() {
  let list = [...allMedia];

  if (currentFilter !== 'all') {
    list = list.filter(item => item.type === currentFilter);
  }

  if (selectedDate !== 'all') {
    list = list.filter(item => (item.date || 'Общие медиа') === selectedDate);
  }

  return newestFirst ? list.reverse() : list;
}

function renderList() {
  const listEl = document.getElementById('media-list');
  const filtered = getFilteredMedia();
  document.getElementById('counter').textContent = filtered.length;

  const zipBtn = document.getElementById('download-zip');
  zipBtn.disabled = filtered.length === 0;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty">Медиафайлы не найдены для выбранной даты.</div>';
    return;
  }

  const groups = new Map();
  filtered.forEach(item => {
    const dateKey = item.date || 'Другие';
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(item);
  });

  listEl.innerHTML = '';

  for (const [dateStr, items] of groups.entries()) {
    const header = document.createElement('div');
    header.className = 'date-group-header';
    header.textContent = `📅 ${dateStr}`;
    listEl.appendChild(header);

    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'media-item';

      const preview = (item.type === 'image' && !item.url.startsWith('blob:'))
        ? `<img src="${item.url}" class="preview" />`
        : `<div class="preview">${item.type === 'video' ? '▶ VIDEO' : '🖼 PHOTO'}</div>`;

      const sizeStr = item.size ? ` • ${(item.size / (1024 * 1024)).toFixed(1)} МБ` : '';

      row.innerHTML = `
        ${preview}
        <div class="info">
          <div class="filename" title="${item.filename}">${item.filename}</div>
          <div class="badge-container">
            <span class="badge">${item.type.toUpperCase()}</span>
            <span class="badge" style="color: #0284c7;">${item.ext.toUpperCase()}${sizeStr}</span>
            ${item.type === 'image' && settings.resize ? `<span class="badge" style="color:#059669;">→ ${settings.size}×${settings.size} ${settings.format === 'png' ? 'PNG' : 'JPG'}</span>` : ''}
          </div>
        </div>
        <button class="dl-btn" title="Скачать файл">↓</button>
      `;

      const dlBtn = row.querySelector('.dl-btn');
      dlBtn.addEventListener('click', () => downloadSingleItem(item, dlBtn));

      listEl.appendChild(row);
    });
  }
}

async function downloadSingleItem(item, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const blob = await getItemBlob(item);

    if (blob && blob.size > 0) {
      const blobUrl = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: blobUrl,
        filename: outputFilename(item),
        conflictAction: 'uniquify'
      });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      btn.textContent = '✓';
    } else {
      btn.textContent = '✕';
    }
  } catch (e) {
    console.error(e);
    btn.textContent = '✕';
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '↓';
    }, 1500);
  }
}

function base64ToUint8Array(dataUrl) {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Достаёт оригинал файла со страницы
async function extractMediaAsBase64InPage(url, mediaType, expectedSize, mimeType) {
  const blobToDataUrl = (blob) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });

  if (window.__umdBlobRegistry && window.__umdBlobRegistry.has(url)) {
    const cachedBlob = window.__umdBlobRegistry.get(url);
    if (cachedBlob instanceof Blob && cachedBlob.size > 0) {
      return await blobToDataUrl(cachedBlob);
    }
  }

  if (mediaType === 'video' && url.includes('stream/')) {
    try {
      const chunks = [];
      let offset = 0;
      let totalSize = expectedSize || null;

      while (true) {
        const res = await fetch(url, {
          headers: { 'Range': `bytes=${offset}-` },
          credentials: 'include'
        });

        if (res.status === 200) {
          const blob = await res.blob();
          return await blobToDataUrl(blob);
        }
        if (!res.ok && res.status !== 206) break;

        const cr = res.headers.get('Content-Range');
        if (cr && !totalSize) {
          const m = cr.match(/\/(\d+)$/);
          if (m) totalSize = parseInt(m[1], 10);
        }

        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) break;
        chunks.push(buf);
        offset += buf.byteLength;

        if (totalSize && offset >= totalSize) break;
      }

      if (chunks.length > 0) {
        const finalBlob = new Blob(chunks, { type: mimeType || 'video/mp4' });
        return await blobToDataUrl(finalBlob);
      }
    } catch (e) {
      console.warn('Stream fetch error:', e);
    }
  }

  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 0) return await blobToDataUrl(blob);
    }
  } catch (e) {}

  // РЕЗЕРВ ДЛЯ ФОТО: снимаем картинку с элемента в полном разрешении без потерь (PNG).
  // Приведение к 700×700 делается уже в попапе.
  if (mediaType === 'image') {
    try {
      const imgs = Array.from(document.querySelectorAll('img'));
      const targetImg = imgs.find(img => img.src === url || img.currentSrc === url);
      if (targetImg && (targetImg.naturalWidth > 0 || targetImg.width > 0)) {
        const canvas = document.createElement('canvas');
        canvas.width = targetImg.naturalWidth || targetImg.width;
        canvas.height = targetImg.naturalHeight || targetImg.height;
        canvas.getContext('2d').drawImage(targetImg, 0, 0);
        return canvas.toDataURL('image/png');
      }
    } catch (canvasErr) {
      console.warn('Canvas fallback error:', canvasErr);
    }
  }

  return null;
}

function scanPageWithDatesAndMedia() {
  const found = [];
  let counter = 1;

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

  function isIgnoredElement(el, filename = '') {
    if (el.matches && el.matches(IGNORE_SELECTORS)) return true;
    if (el.closest && el.closest(IGNORE_SELECTORS)) return true;
    if (/^(sticker|animatedsticker|emoji)/i.test(filename)) return true;
    if (/\.(webp|tgs)$/i.test(filename)) return true;

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && (rect.width < 100 || rect.height < 100)) return true;

    return false;
  }

  function getDateForElement(el) {
    const dateGroup = el.closest('section.bubbles-date-group');
    if (dateGroup) {
      const dateSpan = dateGroup.querySelector('.bubble.service.is-date .service-msg span, .bubble.service.is-date span');
      if (dateSpan && dateSpan.textContent.trim()) {
        return dateSpan.textContent.trim();
      }
    }
    return 'Общие медиа';
  }

  document.querySelectorAll('video').forEach(vid => {
    const rawSrc = vid.getAttribute('src') || vid.currentSrc || vid.src || (vid.querySelector('source')?.src);
    if (!rawSrc) return;

    const fullUrl = rawSrc.startsWith('blob:') ? rawSrc : new URL(rawSrc, document.baseURI).href;
    let filename = `video_${counter++}.mp4`;
    let ext = 'mp4';
    let size = null;
    let mimeType = 'video/mp4';

    if (fullUrl.includes('stream/')) {
      try {
        const encoded = fullUrl.substring(fullUrl.indexOf('stream/') + 7).split('?')[0];
        const info = JSON.parse(decodeURIComponent(encoded));
        if (info.fileName) {
          filename = info.fileName;
          const m = filename.match(/\.([a-zA-Z0-9]+)$/);
          if (m) ext = m[1].toLowerCase();
        }
        if (info.size) size = info.size;
        if (info.mimeType) mimeType = info.mimeType;
      } catch (e) {}
    }

    if (isIgnoredElement(vid, filename)) return;

    found.push({
      url: fullUrl,
      type: 'video',
      ext,
      filename,
      size,
      mimeType,
      date: getDateForElement(vid),
      isBlobOrStream: rawSrc.startsWith('blob:') || fullUrl.includes('stream/') || fullUrl.includes('progressive/')
    });
  });

  document.querySelectorAll('img').forEach(img => {
    const container = img.closest('.media-container, .media-viewer-aspecter, .ckin__player');
    if (container && container.querySelector('video')) return;
    if (img.parentElement && img.parentElement.querySelector('video')) return;

    if (!img.src) return;

    let ext = 'jpg';
    const m = img.src.match(/\.([a-zA-Z0-9]{3,4})(\?|$)/);
    if (m) ext = m[1].toLowerCase();

    const filename = `photo_${counter++}.${ext}`;

    if (isIgnoredElement(img, filename)) return;
    const w = img.naturalWidth || img.clientWidth;
    const h = img.naturalHeight || img.clientHeight;
    if (w < 120 || h < 120) return;

    found.push({
      url: img.src,
      type: 'image',
      ext,
      filename,
      size: null,
      mimeType: 'image/jpeg',
      date: getDateForElement(img),
      isBlobOrStream: img.src.startsWith('blob:')
    });
  });

  return found;
}

function initSettingsUI() {
  const resizeEl = document.getElementById('opt-resize');
  const sizeEl = document.getElementById('opt-size');
  const formatEl = document.getElementById('opt-format');
  const bgEl = document.getElementById('opt-bg');

  resizeEl.checked = !!settings.resize;
  sizeEl.value = settings.size;
  formatEl.value = settings.format;
  bgEl.value = settings.bg;

  const syncState = () => {
    const off = !resizeEl.checked;
    sizeEl.disabled = formatEl.disabled = bgEl.disabled = off;
    const transparentOpt = bgEl.querySelector('option[value="transparent"]');
    transparentOpt.disabled = formatEl.value !== 'png';
    if (formatEl.value !== 'png' && bgEl.value === 'transparent') bgEl.value = 'white';
  };

  const onChange = () => {
    syncState();
    settings = {
      resize: resizeEl.checked,
      size: Math.min(5000, Math.max(16, parseInt(sizeEl.value, 10) || 700)),
      format: formatEl.value,
      bg: bgEl.value
    };
    saveSettings();
    if (allMedia.length) renderList();
  };

  [resizeEl, formatEl, bgEl].forEach(el => el.addEventListener('change', onChange));
  sizeEl.addEventListener('change', onChange);
  syncState();
}
