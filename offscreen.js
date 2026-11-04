// Persist finished videos locally so a stopped draft survives a browser restart.
import { Zip, ZipPassThrough } from './vendor/fflate.js';
const sessions = new Map();
const bundles = new Set();
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('epic-recap-media', 3);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos');
    if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips');
    if (!db.objectStoreNames.contains('clipParts')) db.createObjectStore('clipParts');
  };
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

async function handle({ type, tabId, streamId, maxMs, files, url, clipMs, keepMs, maxBytes }) {
  switch (type) {
    case 'roll-start': return rollStart(tabId, streamId, { clipMs, keepMs, maxBytes });
    case 'roll-stop': await rollStop(tabId); return {};
    case 'roll-cut': await Promise.all([...rolling.keys()].map((id) => cut(id, true))); return {};
    case 'roll-status': return rollStatus();
    case 'clips': return { clips: await listClips() };
    case 'clips-clear': await clearClips(); return {};
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
  // Fold ZIP output into Blobs every ~16 MB so a long video never sits in JS memory whole.
  const blobs = [];
  let chunks = [], pending = 0, failure;
  const zip = new Zip((error, chunk) => {
    if (error) { failure = error; return; }
    chunks.push(chunk); pending += chunk.length;
    if (pending > 16 * 1048576) { blobs.push(new Blob(chunks)); chunks = []; pending = 0; }
  });
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
  const blob = new Blob([...blobs, ...chunks], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  bundles.add(url);
  return { url, size: blob.size };
}

// ---------- continuous mode: rolling clips ----------
// One tab records into self-contained clips: every clipMs the recorder restarts on the
// same stream, so each finished clip is a playable file. While a clip records, its data
// goes to IndexedDB every FLUSH_MS, so memory stays small and a crash loses seconds, not
// a whole clip. Clips older than keepMs (counted from the newest) or beyond maxBytes are
// dropped, oldest first. Video is lighter than manual recording (720p, 10 fps, VP8) because
// it runs for hours next to the page; it pauses itself when the disk runs low.
const ROLL_VIDEO = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 10 };
const ROLL_BITS = { videoBitsPerSecond: 800_000, audioBitsPerSecond: 32_000 };
const FLUSH_MS = 10_000;
const MIN_FREE_BYTES = 1024 ** 3;
const LOW_SPACE = '磁盘剩余空间不足 1 GB，视频已暂停；操作、请求和截图照常记录。';
const rolling = new Map();
const clipUrls = new Map();
let rollError = '';

function idb(name, mode, work) {
  return database.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const result = work(tx.objectStore(name));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onabort = () => reject(tx.error || new Error('视频保存失败'));
    tx.onerror = () => reject(tx.error);
  }));
}
const allClips = () => idb('clips', 'readonly', (store) => store.getAll());
const partRange = (clipId) => IDBKeyRange.bound(`${clipId}:`, `${clipId}:\uffff`);

async function lowOnSpace() {
  const { quota, usage = 0 } = await navigator.storage.estimate().catch(() => ({}));
  return quota !== undefined && quota - usage < MIN_FREE_BYTES;
}

async function rollStart(tabId, streamId, limits) {
  if (rolling.has(tabId)) return {};
  await salvage();
  if (await lowOnSpace()) { rollError = LOW_SPACE; throw new Error(LOW_SPACE); }
  rollError = '';
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { ...source, ...ROLL_VIDEO } },
    audio: { mandatory: source },
  });
  let audioContext;
  if (stream.getAudioTracks().length) {
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
  }
  const r = { tabId, stream, audioContext, limits };
  rolling.set(tabId, r);
  stream.getVideoTracks()[0]?.addEventListener('ended', () => rollStop(tabId).catch(() => {}));
  record(r);
  return {};
}

function record(r) {
  // VP8 costs far less CPU than VP9 for hours of screen content.
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(r.stream, { mimeType, ...ROLL_BITS });
  const clip = { id: `${r.tabId}-${Date.now()}`, tabId: r.tabId, startedAt: Date.now(), seq: 0, size: 0 };
  let writes = Promise.resolve();
  r.recorder = recorder; r.clip = clip;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    const key = `${clip.id}:${String(clip.seq++).padStart(6, '0')}`, part = { clipId: clip.id, tabId: clip.tabId, startedAt: clip.startedAt, t: Date.now(), blob: e.data };
    clip.size += e.data.size;
    writes = writes.then(() => idb('clipParts', 'readwrite', (store) => store.put(part, key)))
      .catch(() => { rollError = '视频写入本地失败，已暂停；操作、请求和截图照常记录。'; });
  };
  r.done = new Promise((resolve) => {
    recorder.onstop = async () => {
      await writes;
      await finish(clip.id, Date.now()).catch(() => {});
      await prune(r.limits).catch(() => {});
      resolve();
    };
  });
  recorder.onerror = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  recorder.start(FLUSH_MS);
  r.timer = setTimeout(() => cut(r.tabId, true), r.limits.clipMs);
}

// Join a clip's saved pieces into one playable file. Blobs read from IndexedDB stay on disk.
async function finish(clipId, endedAt) {
  const parts = await idb('clipParts', 'readonly', (store) => store.getAll(partRange(clipId)));
  if (parts.length) {
    const blob = new Blob(parts.map((p) => p.blob), { type: 'video/webm' });
    const { tabId, startedAt } = parts[0], end = Math.max(endedAt || 0, parts.at(-1).t);
    const clip = { id: clipId, tabId, startedAt, endedAt: end, duration: end - startedAt, size: blob.size, blob };
    await idb('clips', 'readwrite', (store) => store.put(clip, clipId));
  }
  await idb('clipParts', 'readwrite', (store) => store.delete(partRange(clipId)));
}

// After a crash or browser restart, pieces of an unfinished clip are turned into a clip.
async function salvage() {
  const active = new Set([...rolling.values()].map((r) => r.clip?.id));
  const keys = await idb('clipParts', 'readonly', (store) => store.getAllKeys());
  const orphans = new Set(keys.map((k) => k.slice(0, k.lastIndexOf(':'))).filter((id) => !active.has(id)));
  for (const id of orphans) await finish(id).catch(() => {});
}

// Finish the current clip; with `next`, keep recording into a new one. Cuts on one tab
// run one after another so the timer and an export never start two recorders.
function cut(tabId, next) {
  const r = rolling.get(tabId);
  if (!r) return Promise.resolve();
  r.cutting = (r.cutting || Promise.resolve()).then(async () => {
    if (r.recorder.state === 'inactive') return;
    clearTimeout(r.timer);
    r.recorder.stop();
    await r.done;
    if (!next || rolling.get(tabId) !== r || !r.stream.active) return;
    if (rollError || await lowOnSpace()) { rollError ||= LOW_SPACE; release(tabId, r); return; }
    record(r);
  });
  return r.cutting;
}

function release(tabId, r) {
  rolling.delete(tabId); clearTimeout(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  r.audioContext?.close();
}

async function rollStop(tabId) {
  const r = rolling.get(tabId);
  if (!r) return;
  await cut(tabId, false);
  if (rolling.get(tabId) === r) release(tabId, r);
}

async function prune({ keepMs, maxBytes }) {
  const clips = (await allClips()).sort((a, b) => b.endedAt - a.endedAt);
  const newest = clips[0]?.endedAt || 0;
  let bytes = 0;
  const drop = clips.filter((c) => (bytes += c.size) > maxBytes || c.endedAt < newest - keepMs).map((c) => c.id);
  if (!drop.length) return;
  await idb('clips', 'readwrite', (store) => drop.forEach((id) => store.delete(id)));
  for (const id of drop) { const u = clipUrls.get(id); if (u) URL.revokeObjectURL(u); clipUrls.delete(id); }
}

// What the popup shows: which tab records, how much video is kept, and why it paused.
async function rollStatus() {
  const clips = await allClips();
  const live = [...rolling.values()].map((r) => r.clip).filter(Boolean);
  const from = Math.min(...clips.map((c) => c.startedAt), ...live.map((c) => c.startedAt));
  return { tabs: [...rolling.keys()], error: rollError,
    keptMs: Number.isFinite(from) ? Date.now() - from : 0,
    bytes: clips.reduce((n, c) => n + c.size, 0) + live.reduce((n, c) => n + c.size, 0) };
}

async function listClips() {
  await salvage();
  return (await allClips()).sort((a, b) => a.startedAt - b.startedAt).map(({ blob, ...clip }) => {
    if (!clipUrls.has(clip.id)) clipUrls.set(clip.id, URL.createObjectURL(blob));
    return { ...clip, url: clipUrls.get(clip.id) };
  });
}

async function clearClips() {
  for (const [tabId, r] of [...rolling]) {
    if (r.recorder.state !== 'inactive') { r.recorder.onstop = null; r.recorder.ondataavailable = null; r.recorder.stop(); }
    release(tabId, r);
  }
  rollError = '';
  await idb('clips', 'readwrite', (store) => store.clear());
  await idb('clipParts', 'readwrite', (store) => store.clear());
  for (const u of clipUrls.values()) URL.revokeObjectURL(u);
  clipUrls.clear();
}
