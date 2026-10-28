// Records a tab's video with MediaRecorder and keeps the finished file in memory
// (as a blob URL) until it is exported, replaced or discarded.
const sessions = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});

async function handle({ type, tabId, streamId, maxMs }) {
  switch (type) {
    case 'video-start': return start(tabId, streamId, maxMs);
    case 'video-stop': return stop(tabId);
    case 'video-get': return info(tabId);
    case 'video-discard': discard(tabId); return {};
    default: throw new Error(`未知指令 ${type}`);
  }
}

function info(tabId) {
  const s = sessions.get(tabId);
  if (!s) return {};
  return { recording: !s.url, url: s.url, size: s.size, duration: s.duration, startedAt: s.startedAt };
}

async function start(tabId, streamId, maxMs) {
  discard(tabId);
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
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      audioContext?.close();
      const blob = new Blob(s.chunks, { type: 'video/webm' });
      s.chunks = [];
      s.size = blob.size;
      s.duration = Date.now() - s.startedAt;
      s.url = URL.createObjectURL(blob);
      clearTimeout(s.timer);
      resolve();
    };
  });
  recorder.ondataavailable = (e) => { if (e.data.size) s.chunks.push(e.data); };
  // The tab was closed or the capture otherwise ended.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (recorder.state !== 'inactive') recorder.stop(); });
  recorder.start(1000);
  s.timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, maxMs + 2000);
  sessions.set(tabId, s);
  return {};
}

async function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return {};
  if (s.recorder.state !== 'inactive') s.recorder.stop();
  await s.done;
  return info(tabId);
}

function discard(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  clearTimeout(s.timer);
  if (s.recorder.state !== 'inactive') {
    s.recorder.onstop = null;
    s.recorder.stop();
    s.stream.getTracks().forEach((t) => t.stop());
    s.audioContext?.close();
  }
  if (s.url) URL.revokeObjectURL(s.url);
}
