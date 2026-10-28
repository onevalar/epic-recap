// Persist finished videos locally so a stopped draft survives a browser restart.
import { Zip, ZipPassThrough } from './vendor/fflate.js';
const sessions = new Map();
const bundles = new Set();
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('epic-recap-media', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('videos');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function storedVideo(tabId, operation, value) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', operation === 'get' ? 'readonly' : 'readwrite');
    const store = tx.objectStore('videos');
    const request = operation === 'put' ? store.put(value, tabId) : store[operation](tabId);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || new Error('视频保存失败'));
    tx.onerror = () => reject(tx.error);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});

async function handle({ type, tabId, streamId, maxMs, files, url }) {
  switch (type) {
    case 'video-start': return start(tabId, streamId, maxMs);
    case 'video-stop': return stop(tabId);
    case 'video-get': return info(tabId);
    case 'video-discard': await discard(tabId); return {};
    case 'bundle': return bundle(files);
    case 'bundle-release': if (bundles.delete(url)) URL.revokeObjectURL(url); return {};
    default: throw new Error(`未知指令 ${type}`);
  }
}

async function info(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    const saved = await storedVideo(tabId, 'get');
    if (saved) { s = { ...saved, url: URL.createObjectURL(saved.blob) }; delete s.blob; sessions.set(tabId, s); }
  }
  if (!s) return {};
  return { recording: Boolean(s.recorder && s.recorder.state !== 'inactive'), url: s.url, size: s.size, duration: s.duration, startedAt: s.startedAt, error: s.error };
}

async function start(tabId, streamId, maxMs) {
  await discard(tabId);
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { ...source, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15 } },
    audio: { mandatory: source },
  });
  // Capturing a tab mutes it for the user; play its sound back so nothing changes for them.
  let audioContext;
  if (stream.getAudioTracks().length) {
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
  }
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
  const s = { recorder, stream, audioContext, chunks: [], startedAt: Date.now() };
  s.done = new Promise((resolve) => {
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      audioContext?.close();
      const blob = new Blob(s.chunks, { type: 'video/webm' });
      s.chunks = [];
      s.size = blob.size;
      s.duration = Date.now() - s.startedAt;
      s.url = URL.createObjectURL(blob);
      clearTimeout(s.timer);
      try { await storedVideo(tabId, 'put', { blob, size: s.size, duration: s.duration, startedAt: s.startedAt }); }
      catch { s.error = '视频尚未保存到本地，请在关闭浏览器前导出。'; }
      resolve();
    };
  });
  recorder.ondataavailable = (e) => { if (e.data.size) s.chunks.push(e.data); };
  recorder.onerror = () => { s.error = '视频录制中断，页面数据仍保留。'; if (recorder.state !== 'inactive') recorder.stop(); };
  // The tab was closed or the capture otherwise ended.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (recorder.state !== 'inactive') recorder.stop(); });
  recorder.start(1000);
  s.timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, maxMs + 2000);
  sessions.set(tabId, s);
  return {};
}

async function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.recorder) return info(tabId);
  if (s.recorder.state !== 'inactive') s.recorder.stop();
  await s.done;
  return info(tabId);
}

async function discard(tabId) {
  const s = sessions.get(tabId);
  if (!s) { await storedVideo(tabId, 'delete'); return; }
  sessions.delete(tabId);
  clearTimeout(s.timer);
  if (s.recorder && s.recorder.state !== 'inactive') {
    s.recorder.onstop = null;
    s.recorder.stop();
    s.stream.getTracks().forEach((t) => t.stop());
    s.audioContext?.close();
  }
  if (s.url) URL.revokeObjectURL(s.url);
  await storedVideo(tabId, 'delete');
}

async function bundle(files) {
  const chunks = [];
  let failure;
  const zip = new Zip((error, chunk) => { if (error) failure = error; else chunks.push(chunk); });
  for (const file of files) {
    const entry = new ZipPassThrough(file.name);
    zip.add(entry);
    if (file.text !== undefined) entry.push(new TextEncoder().encode(file.text), true);
    else {
      if (!/^(data:|blob:)/.test(file.url)) throw new Error('附件不是本地文件。');
      const response = await fetch(file.url);
      if (!response.ok) throw new Error('附件已不可用，请返回检查页重新选择。');
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        entry.push(value);
      }
      entry.push(new Uint8Array(), true);
    }
    if (failure) throw failure;
  }
  zip.end();
  if (failure) throw failure;
  const blob = new Blob(chunks, { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  bundles.add(url);
  return { url, size: blob.size };
}
