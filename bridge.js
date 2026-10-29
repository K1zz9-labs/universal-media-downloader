// Передаёт настройки из chrome.storage в MAIN-мир страницы (content.js) через data-атрибут.
(function () {
  const DEFAULTS = { resize: true, size: 700, format: 'jpeg', bg: 'white' };

  function apply(s) {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.umdSettings = JSON.stringify(Object.assign({}, DEFAULTS, s || {}));
  }

  chrome.storage.local.get('umdSettings', (r) => apply(r && r.umdSettings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.umdSettings) apply(changes.umdSettings.newValue);
  });
})();
