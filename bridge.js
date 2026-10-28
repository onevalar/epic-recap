// Runs in the extension's isolated world next to hook.js. Forwards the page's
// signals (screenshot requests, performance ticks, hand-offs) to the service
// worker, and lets pages of a continuously recorded site join the recording.
document.addEventListener('__epicTS:signal', (e) => {
  try {
    chrome.runtime.sendMessage(JSON.parse(e.detail)).catch(() => {});
  } catch {}
});

(async () => {
  try {
    const ancestors = location.ancestorOrigins;
    const topOrigin = window === top ? location.origin : ancestors?.[ancestors.length - 1];
    const { continuousSites = {} } = await chrome.storage.local.get('continuousSites');
    if (!continuousSites[topOrigin]) return;
    const rec = await chrome.runtime.sendMessage({ type: 'hello' });
    if (rec) document.dispatchEvent(new CustomEvent('__epicTS:control', { detail: JSON.stringify(rec) }));
  } catch {}
})();
