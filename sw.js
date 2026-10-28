import {
  authorizeVideo, closeSession, disableContinuous, discardTab, enableContinuous, exportRange, exportSession, getState,
  helloFromFrame, isRecordingTab, joinSession, leaveSession, memberClosed, originOf, rotateSegment,
  showRecordingBadge, startSession, stopSession, startContinuousGroup, stopContinuousGroup, closeContinuous, withLifecycle,
} from './export.js';
import {
  clearAllTabData, getContinuousSites, getSession, handleHandover, handleShotRequest, handleTick,
  onBeforeRequest, onCompleted, onErrorOccurred, onSendHeaders, recordSwitch,
} from './capture.js';

// webRequest listeners have to be registered synchronously when the worker starts.
const ALL_URLS = { urls: ['<all_urls>'] };
chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, ALL_URLS);
chrome.webRequest.onSendHeaders.addListener(onSendHeaders, ALL_URLS, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onCompleted.addListener(onCompleted, ALL_URLS, ['responseHeaders', 'extraHeaders']);
chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, ALL_URLS);

async function runCommand(message) {
  if (['state', 'export', 'export-range'].includes(message.name)) return dispatchCommand(message);
  return withLifecycle(() => dispatchCommand(message));
}
async function dispatchCommand({ name, tabId, options = {} }) {
  const tab = () => chrome.tabs.get(tabId);
  switch (name) {
    case 'state': return getState(tabId, options);
    case 'start': return startSession(options.tabIds || [tabId], { video: Boolean(options.video) }, tabId);
    case 'join': return joinSession(tabId);
    case 'leave': return leaveSession(options.tabId ?? tabId);
    case 'stop': return stopSession();
    case 'close': return closeSession(options);
    case 'export': return exportSession(await tab(), options.note, options);
    case 'video-authorize': return authorizeVideo(tabId);
    case 'continuous-on': return startContinuousGroup(options.origins || [originOf((await tab()).url)]);
    case 'continuous-off': return stopContinuousGroup();
    case 'continuous-close': return closeContinuous(options);
    case 'export-range': return exportRange(await tab(), options);
    default: throw new Error(`未知指令 ${name}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  switch (msg?.type) {
    case 'shot': if (sender.tab) handleShotRequest(sender.tab, msg); return false;
    case 'tick': if (sender.tab) handleTick(sender.tab, msg); return false;
    case 'flush': if (sender.tab) handleHandover(sender.tab, sender.frameId, msg); return false;
    case 'hello':
      withLifecycle(() => helloFromFrame(sender)).then(sendResponse, () => sendResponse(null));
      return true;
    case 'command':
      runCommand(msg).then((result) => sendResponse({ ok: true, result }), (err) => sendResponse({ ok: false, error: err.message }));
      return true;
    default: return false;
  }
});

function flashBadge(tabId, ok, title) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#16a34a' : '#dc2626' });
  chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' });
  if (title) chrome.action.setTitle({ tabId, title });
  setTimeout(async () => {
    const rec = await isRecordingTab(tabId);
    if (rec) showRecordingBadge(tabId, rec.mode); else chrome.action.setBadgeText({ tabId, text: '' });
  }, 3000);
}

// Shortcut. Continuous sites: export the last 10 minutes. Otherwise the first
// press starts a session on the tabs ticked last time, the second stops and exports.
async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  try {
    const origin = originOf(tab.url);
    if (origin && (await getContinuousSites())[origin]) {
      await exportRange(tab, { minutes: 10 });
      flashBadge(tab.id, true, 'Epic Recap');
      return;
    }
    const session = await getSession();
    if (session && !session.stoppedAt) {
      await withLifecycle(() => stopSession());
      await exportSession(tab);
      flashBadge(tab.id, true, 'Epic Recap');
      return;
    }
    if (session?.stoppedAt) await withLifecycle(() => closeSession());
    const tabIds = [tab.id];
    const { prefVideo } = await chrome.storage.local.get('prefVideo');
    await withLifecycle(() => startSession(tabIds, { video: prefVideo !== false }, tab.id));
  } catch (err) {
    flashBadge(tab.id, false, `操作失败：${err.message}`);
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') toggleActiveTab();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Manual: the pages stop themselves at the 10-minute mark; this ends the session and its videos.
  if (alarm.name === 'stop:session') { withLifecycle(() => stopSession('auto')).catch(() => {}); return; }
  // Continuous: close the tab's 5-minute segment and start the next.
  if (alarm.name.startsWith('seg:')) withLifecycle(() => rotateSegment(Number(alarm.name.slice(4)), { restart: true })).catch(() => {});
});

// Switching to a recorded tab goes on the timeline, with a screenshot of what it shows.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!(await isRecordingTab(tabId))) return;
  const shot = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await recordSwitch({ t: Date.now(), tabId, shot });
  setTimeout(() => handleShotRequest({ id: tabId }, { id: shot, problem: false }), 500);
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const rec = await isRecordingTab(tabId);
  if (!rec) return;
  // A continuously recorded tab left the site: save what it has and stop.
  if (info.url && rec.mode === 'continuous' && originOf(info.url) !== rec.origin) {
    await withLifecycle(() => rotateSegment(tabId, { restart: false }));
    return;
  }
  // Keep the REC badge on while the recording tab reloads or navigates.
  if (info.status === 'loading') showRecordingBadge(tabId, rec.mode);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await isRecordingTab(tabId);
  if (rec?.mode === 'continuous') {
    await withLifecycle(() => rotateSegment(tabId, { restart: false })).catch(() => {});
    await discardTab(tabId).catch(() => {});
    return;
  }
  if (await withLifecycle(() => memberClosed(tabId))) return;
  await discardTab(tabId).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { clearAllTabData().catch(() => {}); });

// Lets automated tests drive the extension without opening the popup.
globalThis.epicTS = { runCommand, toggleActiveTab, rotateSegment };
