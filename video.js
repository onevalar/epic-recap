// Optional tab video. The recording itself runs in an offscreen document,
// because a service worker cannot hold a media stream.
import { CONTINUOUS_KEEP_MINUTES, MAX_MINUTES } from './capture.js';

let creating;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '录制当前标签页的视频，用于问题排查',
  }).finally(() => { creating = null; });
  await creating;
}

async function send(type, tabId, extra = {}) {
  if (type !== 'video-start' && !(await chrome.offscreen.hasDocument())) return {};
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type, tabId, ...extra });
  if (!res?.ok) throw new Error(res?.error || '视频录制没有响应');
  return res;
}

export async function startVideo(tabId) {
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    throw new Error(`无法录制这个标签页的视频：${err.message}`);
  }
  await ensureOffscreen();
  await send('video-start', tabId, { streamId, maxMs: MAX_MINUTES * 60000 });
}

// Continuous mode: one tab records rolling clips; the last CLIP_KEEP_MINUTES are kept, within CLIP_MAX_BYTES.
export const CLIP_MINUTES = 5;
// About 0.8 Mbps, so 30 minutes is roughly 180 MB; the cap leaves room for busy pages.
export const CLIP_KEEP_MINUTES = CONTINUOUS_KEEP_MINUTES;
const CLIP_MAX_BYTES = 300 * 1048576;
export async function startRollingVideo(tabId) {
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    throw new Error(`无法录制这个标签页的视频：${err.message}`);
  }
  await ensureOffscreen();
  await send('roll-start', tabId, { streamId, clipMs: CLIP_MINUTES * 60000, keepMs: CLIP_KEEP_MINUTES * 60000, maxBytes: CLIP_MAX_BYTES });
}
export const stopRollingVideo = (tabId) => send('roll-stop', tabId);
export const cutRollingVideo = () => send('roll-cut', null);
export const rollingVideoStatus = async () => (await chrome.offscreen.hasDocument() ? send('roll-status', null) : { tabs: [] });
export const rollingVideoTabs = async () => (await rollingVideoStatus()).tabs || [];
export const listClips = async () => { await ensureOffscreen(); return (await send('clips', null)).clips; };
export const clearClips = async () => { await ensureOffscreen(); return send('clips-clear', null); };

export const stopVideo = (tabId) => send('video-stop', tabId);
export const getVideo = async (tabId) => { await ensureOffscreen(); return send('video-get', tabId); };
export const discardVideo = async (tabId) => { await ensureOffscreen(); return send('video-discard', tabId); };
export const bundleFiles = async (files) => { await ensureOffscreen(); return send('bundle', null, { files }); };
export const releaseBundle = (url) => send('bundle-release', null, { url });
