// Optional tab video. The recording itself runs in an offscreen document,
// because a service worker cannot hold a media stream.
import { MAX_MINUTES } from './capture.js';

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

export const stopVideo = (tabId) => send('video-stop', tabId);
export const getVideo = async (tabId) => { await ensureOffscreen(); return send('video-get', tabId); };
export const discardVideo = async (tabId) => { await ensureOffscreen(); return send('video-discard', tabId); };
export const bundleFiles = async (files) => { await ensureOffscreen(); return send('bundle', null, { files }); };
export const releaseBundle = (url) => send('bundle-release', null, { url });
