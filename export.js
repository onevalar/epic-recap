// Recording lifecycle and export. Runs in the service worker; the popup and the
// shortcut both go through it so collectors and video have a single owner.
//
// Two modes:
// - manual: a session started from the popup on up to MAX_TABS tabs at once;
//   stops on request or after MAX_MINUTES.
// - continuous: switched on per site (a group of origins, e.g. two localhost
//   ports); up to MAX_TABS of their tabs record all the time, cut into
//   SEGMENT_MINUTES segments of which the last MAX_SEGMENTS per site are kept.
//   Export picks a time range across all of them.
import { buildMarkdown, buildNetworkCsv } from './report.js';
import {
  MAX_MINUTES, SEGMENT_MINUTES, clearCollected, clearRecording, clearSegments, countShots, getCollected,
  getContinuousSites, getRecording, getSession, getShots, getSwitches, listSegments, loadSegment,
  recordingTabsList, saveSegment, segmentBytes, setContinuousSite, setRecording, setSession,
} from './capture.js';
import { discardVideo, getVideo, startVideo, stopVideo } from './video.js';

export const MAX_TABS = 4;
export const MAX_VIDEO_TABS = MAX_TABS;
const MAX_EXPORT_SHOTS = 18;
const NOT_READY = '页面还没准备好，请刷新后再试。';
const SUMMED = ['requests', 'failedRequests', 'errors', 'actions', 'bytes', 'events'];

export function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}

// Short name for a tab in the report and popup: port (or host) plus page title.
export function labelOf(url, title) {
  let where = '';
  try { const u = new URL(url); where = u.port || u.hostname; } catch {}
  const t = (title || '').trim();
  return [where, t.length > 12 ? `${t.slice(0, 12)}…` : t].filter(Boolean).join(' ') || '标签页';
}

const frames = (tabId, func, args = []) =>
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func, args });
const topOf = (results) => results.find((r) => r.frameId === 0)?.result;
const tabOrNull = (tabId) => chrome.tabs.get(tabId).catch(() => null);
const videoOf = (tabId) => getVideo(tabId).catch(() => ({}));

async function pageState(tabId) {
  let results;
  try { results = await frames(tabId, () => window.__epicTS?.state() ?? null); } catch { return null; }
  const top = topOf(results);
  if (!top) return null;
  const total = { ...top };
  for (const r of results) if (r.frameId !== 0 && r.result) for (const k of SUMMED) total[k] += r.result[k];
  return total;
}

export async function showRecordingBadge(tabId, mode = 'manual') {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: mode === 'continuous' ? '#ea580c' : '#dc2626' }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: 'REC' }).catch(() => {});
}
const clearBadge = (tabId) => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});

export const isRecordingTab = (tabId) => getRecording(tabId);

// ---------- what the popup shows ----------

export async function getState(tabId, { candidates = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const origin = originOf(tab.url);
  const [page, session, sites, run, task] = await Promise.all([
    pageState(tabId), getSession(), getContinuousSites(), getContinuousRun(), getExportTask(),
  ]);
  return {
    tabId, origin, url: tab.url, title: tab.title, label: labelOf(tab.url, tab.title), pageReady: Boolean(page), page,
    session: session ? await describeSession(session, tabId) : null,
    continuous: run || Object.keys(sites).length ? await describeContinuous(sites, tabId, origin, run) : null,
    exportTask: task && (!task.runId || task.runId === String(session?.startedAt) || task.runId === run?.id) ? task : null,
    candidates: candidates ? await candidateTabs(tabId) : [],
    limits: { tabs: MAX_TABS, videoTabs: MAX_VIDEO_TABS, minutes: MAX_MINUTES },
  };
}

async function describeSession(session, viewerTabId) {
  const members = [];
  const totals = { actions: 0, requests: 0, failedRequests: 0, errors: 0, shots: 0, bytes: 0 };
  const videos = await Promise.all(Object.keys(session.tabs).map((id) => videoOf(Number(id))));
  const videoFull = videos.filter((v) => v.recording || v.url).length >= MAX_VIDEO_TABS;
  for (const [id, info] of Object.entries(session.tabs)) {
    const tabId = Number(id);
    const tab = await tabOrNull(tabId);
    const page = tab ? await pageState(tabId) : null;
    const shots = await countShots(tabId);
    const video = await videoOf(tabId);
    const counts = page || info.counts;
    if (counts) for (const k of ['actions', 'requests', 'failedRequests', 'errors', 'bytes']) totals[k] += counts[k] || 0;
    totals.shots += shots;
    members.push({
      tabId, title: tab?.title || info.title || info.label, url: tab?.url || info.url, label: tab ? labelOf(tab.url, tab.title) : info.label, closed: !tab,
      video: video.recording ? 'recording' : video.url ? 'done' : !session.video ? 'off' : videoFull ? 'limit' : 'waiting',
      videoSize: video.size || 0,
    });
  }
  const archive = (await chrome.storage.local.get('manualArchive')).manualArchive;
  if (archive?.runId === String(session.startedAt) && session.stoppedAt) {
    Object.assign(totals, totalsForParts(archive.parts));
  }
  return {
    lastExport: session.lastExport,
    startedAt: session.startedAt, stoppedAt: session.stoppedAt, stopReason: session.stopReason, video: session.video,
    active: !session.stoppedAt, isMember: Boolean(session.tabs[viewerTabId]), members, totals,
    videoTabs: members.filter((m) => m.video === 'recording' || m.video === 'done').length,
  };
}

async function describeContinuous(sites, viewerTabId, origin, run) {
  const groups = run?.origins || Object.keys(sites);
  const tabs = await recordingTabsList('continuous');
  const recording = [], parts = [], indexes = [];
  for (const r of tabs) {
    if (!groups.includes(r.origin)) continue;
    const tab = await tabOrNull(r.tabId);
    if (tab) {
      recording.push({ tabId: r.tabId, origin: r.origin, title: tab.title, url: tab.url, label: labelOf(tab.url, tab.title), startedAt: r.startedAt });
      const page = await pageState(r.tabId);
      if (page) parts.push(page);
    }
  }
  let oldest = null, newest = null;
  const members = new Set(recording.map(r => r.tabId));
  for (const o of groups) {
    for (const item of await listSegments(o)) {
      indexes.push(item); members.add(item.tabId);
      oldest = Math.min(oldest ?? item.startedAt, item.startedAt);
      newest = Math.max(newest ?? item.endedAt, item.endedAt);
    }
  }
  for (const r of recording) oldest = Math.min(oldest ?? r.startedAt, r.startedAt);
  const totals = { errors: 0, failedRequests: 0 };
  for (const count of [...indexes.map(s => s.counts || {}), ...parts]) {
    totals.errors += count.errors || 0; totals.failedRequests += count.failedRequests || 0;
  }
  const active = groups.some(o => sites[o]);
  return {
    id: run?.id, active, startedAt: run?.startedAt, stoppedAt: run?.stoppedAt, lastExport: run?.lastExport,
    origins: groups.map(o => ({ origin: o, host: new URL(o).host, count: recording.filter(r => r.origin === o).length })),
    inGroup: Boolean(origin && groups.includes(origin)), thisTabRecording: recording.some(r => r.tabId === viewerTabId),
    recording, segments: indexes.length, oldest, newest: active && recording.length ? Date.now() : newest,
    full: recording.length >= MAX_TABS, totals, pageCount: members.size,
  };
}

async function candidateTabs(viewerTabId) {
  const sites = await getContinuousSites();
  const tabs = await chrome.tabs.query({});
  const isLocal = t => /^(localhost|127\.0\.0\.1)$/.test((() => { try { return new URL(t.url).hostname; } catch { return ''; } })());
  tabs.sort((a, b) => (b.id === viewerTabId) - (a.id === viewerTabId) || isLocal(b) - isLocal(a));
  const result = [];
  // Bound injection concurrency when a browser has hundreds of tabs.
  for (let i = 0; i < tabs.length; i += 6) {
    result.push(...await Promise.all(tabs.slice(i, i + 6).map(async t => {
      const origin = originOf(t.url), ready = Boolean(origin && await pageState(t.id));
      return { tabId: t.id, title: t.title, label: labelOf(t.url, t.title), url: t.url, origin,
        current: t.id === viewerTabId, checked: t.id === viewerTabId && ready,
        ready, reason: !origin ? '浏览器页面 · 无法记录' : sites[origin] ? '正在持续记录' : !ready ? '需刷新页面后才能记录' : '',
        available: ready && !sites[origin] };
    })));
  }
  return result;
}

// ---------- manual sessions ----------

async function discardSession(session) {
  if (!session) return;
  for (const id of Object.keys(session.tabs)) {
    const tabId = Number(id);
    await clearRecording(tabId);
    await clearCollected(tabId);
    await discardVideo(tabId).catch(() => {});
    await clearBadge(tabId);
  }
  await chrome.alarms.clear('stop:session');
  await setSession(null);
  await chrome.storage.local.remove(['manualArchive', 'manualNote']);
}

async function joinTab(session, tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = originOf(tab.url);
  if (!origin) throw new Error(`「${labelOf(tab.url, tab.title)}」不支持记录`);
  if ((await getContinuousSites())[origin]) throw new Error(`「${labelOf(tab.url, tab.title)}」所在网址已开启持续记录`);
  await clearCollected(tabId);
  // Collectors key off this flag, so set it before the page starts sending signals.
  await setRecording(tabId, { startedAt: session.startedAt, mode: 'manual' });
  let results = null;
  try { results = await frames(tabId, (t) => window.__epicTS?.start(t, 'manual') ?? null, [session.startedAt]); } catch {}
  if (!results || !topOf(results)) {
    await clearRecording(tabId);
    throw new Error(`「${labelOf(tab.url, tab.title)}」还没准备好，请刷新这个页面后再试`);
  }
  session.tabs[tabId] = { title: tab.title, label: labelOf(tab.url, tab.title), url: tab.url };
  await showRecordingBadge(tabId);
}

async function maybeStartVideo(session, tabId) {
  if (!session.video || !session.tabs[tabId]) return;
  const video = await videoOf(tabId);
  if (video.recording || video.url) return;
  const running = (await Promise.all(Object.keys(session.tabs).map((id) => videoOf(Number(id)))))
    .filter((v) => v.recording || v.url).length;
  if (running >= MAX_VIDEO_TABS) return;
  await startVideo(tabId);
}

// `viewerTabId` is where the user clicked the extension, the only tab whose video can start right away.
export async function startSession(tabIds, { video = false } = {}, viewerTabId) {
  if (!tabIds.length) throw new Error('请至少选择一个标签页。');
  if (tabIds.length > MAX_TABS) throw new Error(`最多同时记录 ${MAX_TABS} 个标签页。`);
  if (await getSession()) throw new Error('请先导出或放弃现有记录。');
  if (await getContinuousRun() || Object.keys(await getContinuousSites()).length) throw new Error('请先结束现有的持续记录。');
  await assertNoExport();
  await chrome.storage.local.remove('exportTask');
  const session = { startedAt: Date.now(), video, tabs: {} };
  const problems = [];
  for (const tabId of tabIds) {
    try { await joinTab(session, tabId); } catch (err) { problems.push(err.message); }
  }
  if (!Object.keys(session.tabs).length) throw new Error(problems.join('；') || NOT_READY);
  await setSession(session);
  await chrome.alarms.create('stop:session', { when: session.startedAt + MAX_MINUTES * 60000 });
  const origins = Object.values(session.tabs).map((t) => originOf(t.url));
  await chrome.storage.local.set({ lastOrigins: [...new Set(origins)], prefVideo: video });
  if (video && session.tabs[viewerTabId]) {
    try { await maybeStartVideo(session, viewerTabId); } catch (err) { problems.push(err.message); }
  }
  return { problems };
}

// Drop a stopped session (after exporting it) so a new one can be set up.
export async function closeSession({ discard = false } = {}) {
  await assertNoExport();
  const session = await getSession();
  if (session && !session.stoppedAt) throw new Error('记录还在进行，请先停止。');
  if (session && !discard && !session.lastExport) throw new Error('请先导出，或确认放弃这次记录。');
  await discardSession(session);
  await chrome.storage.local.remove(['exportTask', 'exportSnapshot']);
  return {};
}

export async function joinSession(tabId) {
  const session = await getSession();
  if (!session || session.stoppedAt) throw new Error('当前没有正在进行的记录。');
  if (session.tabs[tabId]) return {};
  if (Object.keys(session.tabs).length >= MAX_TABS) throw new Error(`最多同时记录 ${MAX_TABS} 个标签页。`);
  await joinTab(session, tabId);
  await setSession(session);
  await maybeStartVideo(session, tabId).catch(() => {});
  return {};
}

// Opening the popup on a tab authorises its video; start it if the session wants one.
export async function authorizeVideo(tabId) {
  const session = await getSession();
  if (!session || session.stoppedAt) return {};
  await maybeStartVideo(session, tabId);
  return {};
}

export async function leaveSession(tabId) {
  const session = await getSession();
  if (!session?.tabs[tabId]) return {};
  if (!session.stoppedAt) await frames(tabId, () => window.__epicTS?.stop('manual')).catch(() => {});
  delete session.tabs[tabId];
  await clearRecording(tabId);
  await clearCollected(tabId);
  await discardVideo(tabId).catch(() => {});
  await clearBadge(tabId);
  if (!Object.keys(session.tabs).length) await discardSession(session);
  else await setSession(session);
  return {};
}

export async function stopSession(reason = 'manual') {
  const session = await getSession();
  if (!session || session.stoppedAt) return {};
  for (const id of Object.keys(session.tabs)) {
    const tabId = Number(id);
    await frames(tabId, (r) => window.__epicTS?.stop(r), [reason]).catch(() => {});
    await clearRecording(tabId);
    await clearBadge(tabId);
    await stopVideo(tabId).catch(() => {});
  }
  session.stoppedAt = Math.min(Date.now(), session.startedAt + MAX_MINUTES * 60000);
  session.stopReason = reason;
  const parts = [];
  for (const [id, info] of Object.entries(session.tabs)) parts.push(await capturePart(Number(id), session.startedAt, info));
  await chrome.storage.local.set({ manualArchive: { runId: String(session.startedAt), parts } });
  await setSession(session);
  await chrome.alarms.clear('stop:session');
  return {};
}

// A member tab was closed: keep what it recorded for the export.
export async function memberClosed(tabId) {
  const session = await getSession();
  if (!session?.tabs[tabId]) return false;
  session.tabs[tabId].closed = true;
  const part = await capturePart(tabId, session.startedAt, session.tabs[tabId]);
  session.tabs[tabId].counts = { ...countsOf(part.events), requests: part.net.length };
  await setSession(session);
  await clearRecording(tabId);
  await stopVideo(tabId).catch(() => {});
  return true;
}

export async function exportSession(viewerTab, note = '', options = {}) {
  return exportWork(async () => {
    const previous = await getExportTask();
    if (options.retry && previous?.mode === 'manual') return retryExport(viewerTab);
    const snapshot = await withLifecycle(async () => {
      const session = await getSession();
      if (!session?.stoppedAt) throw new Error('请先停止记录。');
      const archive = (await chrome.storage.local.get('manualArchive')).manualArchive;
      const parts = [];
      for (const [id, info] of Object.entries(session.tabs)) {
        const part = archive?.runId === String(session.startedAt) ? structuredClone(archive.parts.find(p => p.tabId === Number(id))) : await capturePart(Number(id), session.startedAt, info);
        if (!part) continue;
        part.video = await videoOf(Number(id)); parts.push(part);
      }
      return { runId: String(session.startedAt), mode: 'manual', parts, note,
        recording: { mode: 'manual', startedAt: session.startedAt, stoppedAt: session.stoppedAt, stopReason: session.stopReason },
        switches: await getSwitches(session.startedAt, session.stoppedAt) };
    });
    return beginExport(viewerTab, snapshot);
  });
}

export async function discardTab(tabId) {
  await clearRecording(tabId);
  await clearCollected(tabId);
  await discardVideo(tabId).catch(() => {});
  await chrome.alarms.clear(`seg:${tabId}`);
  await clearBadge(tabId);
}

// ---------- everything one tab recorded since `startedAt` ----------

function fallbackMeta(page, info) {
  return {
    url: page?.url || info?.url || '', title: page?.title || info?.title || '', userAgent: navigator.userAgent, language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, viewport: '未知（页面已关闭）', screen: '未知',
    device: {}, metadata: null, dropped: 0,
  };
}

async function capturePart(tabId, startedAt, info) {
  let results = [];
  try { results = await frames(tabId, () => window.__epicTS?.snapshot() ?? null); } catch {}
  const top = topOf(results);
  const pageEvents = [];
  let dropped = 0;
  for (const r of results) {
    if (!r.result || r.result.meta.recording?.startedAt !== startedAt) continue;
    dropped += r.result.meta.dropped;
    const frame = r.frameId === 0 ? undefined : r.result.meta.url;
    for (const e of r.result.events) pageEvents.push(frame ? { ...e, frame } : e);
  }
  const [collected, shots] = await Promise.all([getCollected(tabId), getShots(tabId)]);
  const seen = new Set();
  const events = [...collected.handover.events, ...pageEvents]
    .filter((e) => e.t >= startedAt && (e.id == null || (!seen.has(e.id) && seen.add(e.id))))
    .sort((a, b) => a.t - b.t);
  const meta = top?.meta ? { ...top.meta, dropped } : fallbackMeta(collected.handover.page, info);
  return {
    tabId, label: labelOf(meta.url, meta.title), startedAt, endedAt: Date.now(),
    meta, events, net: collected.net, perf: collected.perf, device: collected.device, shots,
  };
}

const countsOf = (events) => ({
  actions: events.filter((e) => e.type === 'action').length,
  errors: events.filter((e) => ['error', 'rejection', 'resource-error'].includes(e.type) || (e.type === 'console' && e.level === 'error')).length,
  failedRequests: events.filter((e) => e.type === 'network' && (!e.status || e.status >= 400 || e.bizError)).length,
});

// ---------- continuous mode ----------

async function startContinuous(tabId, origin, { inject }) {
  const rec = { startedAt: Date.now(), mode: 'continuous', origin };
  await setRecording(tabId, rec);
  await chrome.alarms.create(`seg:${tabId}`, { when: rec.startedAt + SEGMENT_MINUTES * 60000 });
  await showRecordingBadge(tabId, 'continuous');
  if (inject) {
    await frames(tabId, (r) => window.__epicTS?.ensure(r), [{ startedAt: rec.startedAt, mode: rec.mode }]).catch(() => {});
  }
  return rec;
}

const continuousFull = async () => (await recordingTabsList('continuous')).length >= MAX_TABS;

// A page (or frame) just loaded: tell it which recording to join, starting a
// continuous one when its site is in the continuous group.
export async function helloFromFrame(sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return null;
  const rec = await getRecording(tabId);
  if (rec) return { startedAt: rec.startedAt, mode: rec.mode };
  if (sender.frameId !== 0) return null;
  const origin = originOf(sender.url);
  if (!origin || !(await getContinuousSites())[origin] || await continuousFull()) return null;
  const started = await startContinuous(tabId, origin, { inject: false });
  return { startedAt: started.startedAt, mode: started.mode };
}

// Close the tab's current segment and, unless the tab is done, start the next one.
export async function rotateSegment(tabId, { restart }) {
  const rec = await getRecording(tabId);
  if (!rec || rec.mode !== 'continuous') return;
  const part = await capturePart(tabId, rec.startedAt);
  // Markers alone (segment start, page load) aren't worth a segment.
  if (part.events.some((e) => !['recording', 'page-load'].includes(e.type)) || part.shots.length > 1 || part.net.length) {
    await saveSegment(rec.origin, { ...part, id: `${tabId}-${rec.startedAt}`, origin: rec.origin, counts: countsOf(part.events) });
  }
  await clearCollected(tabId);
  const tab = restart ? await tabOrNull(tabId) : null;
  if (tab && originOf(tab.url) === rec.origin && (await getContinuousSites())[rec.origin]) {
    await startContinuous(tabId, rec.origin, { inject: true });
  } else {
    await clearRecording(tabId);
    await chrome.alarms.clear(`seg:${tabId}`);
    await clearBadge(tabId);
  }
}

export async function enableContinuous(origin) {
  return startContinuousGroup([origin]);
}

export async function startContinuousGroup(origins) {
  const chosen = [...new Set(origins)].filter(o => originOf(o) === o);
  if (!chosen.length || chosen.length !== new Set(origins).size || chosen.length > MAX_TABS) throw new Error('请选择 1–4 个有效站点。');
  if (await getSession()) throw new Error('请先导出或放弃现有记录。');
  if (await getContinuousRun() || Object.keys(await getContinuousSites()).length) throw new Error('已有持续记录，请先停止并处理记录。');
  await assertNoExport();
  const run = { id: crypto.randomUUID(), origins: chosen, startedAt: Date.now(), stoppedAt: null };
  await chrome.storage.local.set({ continuousRun: run });
  await chrome.storage.local.remove(['exportTask', 'continuousNote']);
  for (const origin of chosen) await setContinuousSite(origin, true);
  const problems = [];
  for (const tab of await chrome.tabs.query({})) {
    if (!chosen.includes(originOf(tab.url)) || await getRecording(tab.id) || await continuousFull()) continue;
    if (!await pageState(tab.id)) { problems.push(`${tab.title || new URL(tab.url).host}：需刷新页面`); continue; }
    await clearCollected(tab.id);
    await startContinuous(tab.id, originOf(tab.url), { inject: true });
  }
  return { problems };
}

export async function stopContinuousGroup() {
  await assertNoExport();
  const run = await getContinuousRun();
  if (!run || run.stoppedAt) return {};
  // Disable auto-joining before flushing the final parts. Never delete saved segments here.
  for (const origin of run.origins) await setContinuousSite(origin, false);
  for (const r of await recordingTabsList('continuous')) {
    if (!run.origins.includes(r.origin)) continue;
    await frames(r.tabId, () => window.__epicTS?.stop('continuous-stop')).catch(() => {});
    await rotateSegment(r.tabId, { restart: false });
  }
  run.stoppedAt = Date.now();
  delete run.lastExport;
  await chrome.storage.local.set({ continuousRun: run });
  await chrome.storage.local.remove(['exportTask', 'exportSnapshot']);
  return {};
}

export async function disableContinuous() { return stopContinuousGroup(); }

export async function closeContinuous({ discard = false } = {}) {
  await assertNoExport();
  const run = await getContinuousRun();
  if (!run) return {};
  if (!run.stoppedAt) throw new Error('请先停止持续记录。');
  if (!discard && !run.lastExport) throw new Error('请先导出，或确认放弃这次记录。');
  for (const origin of run.origins) await clearSegments(origin);
  await chrome.storage.local.remove(['continuousRun', 'continuousNote', 'exportTask', 'exportSnapshot']);
  return {};
}

export async function getContinuousRun() {
  const run = (await chrome.storage.local.get('continuousRun')).continuousRun;
  if (run) return run;
  const origins = Object.keys(await getContinuousSites());
  if (!origins.length) return null;
  const migrated = { id: crypto.randomUUID(), origins, startedAt: Date.now(), stoppedAt: null };
  await chrome.storage.local.set({ continuousRun: migrated });
  return migrated;
}

function totalsForParts(parts) {
  return parts.reduce((sum, p) => {
    const c = countsOf(p.events); for (const k of ['errors', 'failedRequests', 'actions']) sum[k] += c[k];
    sum.requests += p.net.length; sum.shots += p.shots.length; return sum;
  }, { actions: 0, requests: 0, failedRequests: 0, errors: 0, shots: 0, bytes: 0 });
}


const within = (from, to) => (x) => x.t >= from && x.t <= to;

// Export the last `minutes` (0 = everything kept) across every tab of the continuous group.
async function rangeSnapshot({ minutes = 10, note = '' } = {}) {
  if (![0, 5, 10, 20].includes(minutes)) throw new Error('无效的导出范围。');
  const run = await getContinuousRun();
  if (!run) throw new Error('没有可导出的持续记录。');
  const now = run.stoppedAt || Date.now();
  const from = minutes ? now - minutes * 60000 : 0;
  const byTab = new Map();
  const add = (part) => {
    const key = part.tabId;
    const trimmed = {
      ...part, events: part.events.filter(within(from, now)), net: part.net.filter(within(from, now)),
      perf: part.perf.filter(within(from, now)), shots: part.shots.filter(within(from, now)),
    };
    const prev = byTab.get(key);
    if (!prev) { byTab.set(key, trimmed); return; }
    // Later segments of the same tab carry the fresher page info.
    const [early, late] = prev.startedAt < trimmed.startedAt ? [prev, trimmed] : [trimmed, prev];
    byTab.set(key, {
      ...late, startedAt: early.startedAt,
      events: [...early.events, ...late.events], net: [...early.net, ...late.net],
      perf: [...early.perf, ...late.perf], shots: [...early.shots, ...late.shots],
      device: late.device || early.device,
      meta: { ...late.meta, dropped: (early.meta.dropped || 0) + (late.meta.dropped || 0) },
    });
  };
  let segmentCount = 0;
  for (const origin of run.origins) {
    for (const s of await listSegments(origin)) {
      if (s.endedAt < from) continue;
      const seg = await loadSegment(s.id);
      if (seg) { add({ ...seg, tabId: Number(seg.tabId ?? s.id.split('-')[0]) }); segmentCount++; }
    }
  }
  for (const r of await recordingTabsList('continuous')) {
    if (!run.origins.includes(r.origin)) continue;
    add(await capturePart(r.tabId, r.startedAt));
    segmentCount++;
  }
  const parts = [...byTab.values()].filter((p) => p.events.length || p.shots.length || p.net.length);
  if (!parts.length) throw new Error('这段时间内没有记录到内容。');
  const startedAt = Math.max(from, Math.min(...parts.map((p) => p.startedAt)));
  return { runId: run.id, mode: 'continuous', parts, note,
    recording: { mode: 'continuous', startedAt, stoppedAt: run.stoppedAt || null, rangeEnd: now, rangeMinutes: minutes, segmentCount },
    switches: await getSwitches(startedAt, now) };
}

export async function exportRange(viewerTab, options = {}) {
  return exportWork(async () => {
    if (options.retry) return retryExport(viewerTab);
    const snapshot = await withLifecycle(() => rangeSnapshot(options));
    return beginExport(viewerTab, snapshot);
  });
}

// ---------- writing the export folder ----------

// Keep problem screenshots first, then spread the rest evenly over time.
function pickShots(shots, max = MAX_EXPORT_SHOTS) {
  const sorted = [...shots].sort((a, b) => a.t - b.t);
  if (sorted.length <= max) return sorted;
  const problems = sorted.filter((s) => s.problem).slice(-max);
  const others = sorted.filter((s) => !s.problem);
  const room = max - problems.length;
  const step = others.length / Math.max(room, 1);
  const spread = room > 0 ? Array.from({ length: room }, (_, i) => others[Math.floor(i * step)]) : [];
  return [...problems, ...spread].sort((a, b) => a.t - b.t);
}

const safeName = (s, max = 30) => (s || '').replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, max).trim();

// One folder per export, named by time only so exports sort chronologically.
function folderName(exportedAt) {
  const d = new Date(exportedAt);
  const p = (n) => String(n).padStart(2, '0');
  return `Epic Recap/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const textUrl = (type, text) => `data:${type};charset=utf-8,${encodeURIComponent(text)}`;

async function saveExport(viewerTab, parts, { recording, switches }, note, job) {
  const exportedAt = job.createdAt;
  const primary = parts.find((p) => p.tabId === viewerTab.id) || [...parts].sort((a, b) => b.events.length - a.events.length)[0];
  const tabs = parts.map((p) => ({
    key: String(p.tabId), label: labelOf(p.meta.url, p.meta.title), url: p.meta.url, title: p.meta.title, metadata: p.meta.metadata,
  }));
  const tag = (p) => (x) => ({ ...x, tab: String(p.tabId) });
  const memberIds = new Set(tabs.map((t) => t.key));

  const events = parts.flatMap((p) => p.events.map(tag(p)));
  for (const s of switches) {
    if (memberIds.has(String(s.tabId))) events.push({ type: 'tab-switch', t: s.t, tab: String(s.tabId), shot: s.shot });
  }
  events.sort((a, b) => a.t - b.t);

  const finalShot = job.finalShot;
  // Screenshots and videos carry the name of the tab they show, e.g. 截图-03-8080 客户端.jpg.
  // Unlike the on-screen label, file names keep the full page title.
  const fullLabel = (url, title) => {
    let where = '';
    try { const u = new URL(url); where = u.port || u.hostname; } catch {}
    return [where, (title || '').trim()].filter(Boolean).join(' ');
  };
  const fileLabel = Object.fromEntries(tabs.map((t) => [t.key, safeName(fullLabel(t.url, t.title), 40) || `标签页${t.key}`]));
  const shots = pickShots(parts.flatMap((p) => p.shots.map(tag(p))))
    .map((s, i) => ({ ...s, file: `截图-${String(i + 1).padStart(2, '0')}-${fileLabel[s.tab]}.jpg` }));
  // Named by port; several tabs on one port get a number.
  const videoNames = new Map();
  const videos = parts.filter((p) => p.video?.url).map((p) => {
    const base = `视频-${fileLabel[String(p.tabId)]}`;
    const n = (videoNames.get(base) || 0) + 1;
    videoNames.set(base, n);
    return { ...p.video, tab: String(p.tabId), file: `${base}${n > 1 ? `-${n}` : ''}.webm` };
  });
  const net = parts.flatMap((p) => p.net.map(tag(p))).sort((a, b) => a.t - b.t);

  const files = { report: '问题报告.md' };
  const viewerLabel = fileLabel[String(viewerTab.id)] || safeName(fullLabel(viewerTab.url, viewerTab.title), 40);
  if (finalShot) files.finalShot = `截图-导出时-${viewerLabel}.png`;
  if (net.length) files.networkCsv = '全部网络请求.csv';

  const meta = {
    ...primary.meta, exportedAt, recording, maxMinutes: MAX_MINUTES,
    dropped: parts.reduce((n, p) => n + (p.meta.dropped || 0), 0),
  };
  const markdown = buildMarkdown({
    meta, tabs, events, net, shots, videos,
    perf: parts.flatMap((p) => p.perf.map(tag(p))).sort((a, b) => a.t - b.t),
    device: [...parts].reverse().find((p) => p.device)?.device || null,
  }, { note, files });

  const folder = job.folder;
  // One export is a dozen files; keep the browser's download bubble quiet while
  // saving them, and leave only the report in its download list.
  const ids = [];
  const save = async (name, url) => ids.push(await chrome.downloads.download({ url, filename: `${folder}/${name}`, conflictAction: 'overwrite' }));
  await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
  try {
    await save(files.report, textUrl('text/markdown', markdown));
    for (const s of shots) await save(s.file, s.dataUrl);
    if (finalShot) await save(files.finalShot, finalShot);
    if (files.networkCsv) await save(files.networkCsv, textUrl('text/csv', buildNetworkCsv(net, tabs)));
    for (const v of videos) await save(v.file, v.url);
    await downloadsSettled(ids);
  } finally {
    await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
  }
  // Erasing only removes the entries from the list; the files stay in the folder.
  for (const id of ids.slice(1)) await chrome.downloads.erase({ id }).catch(() => {});
  return { folder, fileCount: ids.length, reportId: ids[0], mode: recording.mode,
    pageCount: parts.length, videoCount: videos.length, startedAt: recording.startedAt, endedAt: recording.rangeEnd || recording.stoppedAt,
    contents: ['报告', ...(net.length ? ['网络记录'] : []), ...(shots.length || finalShot ? ['截图'] : []), ...(videos.length ? ['视频'] : [])] };
}

async function downloadsSettled(ids, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const items = await chrome.downloads.search({});
    const relevant = ids.map(id => items.find(i => i.id === id));
    const interrupted = relevant.find(i => i?.state === 'interrupted');
    if (interrupted) throw new Error(`下载未完成：${interrupted.error || '下载已中断'}。记录已保留。`);
    if (relevant.every(i => i?.state === 'complete')) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('下载超时，记录已保留，请重试。');


}


// A short lifecycle queue protects capture/stop/rotation; downloads use a separate queue
// so exporting a snapshot never blocks new continuous pages or segment rotation.
let lifecycle = Promise.resolve(), exporting = false;
export function withLifecycle(job) {
  const result = lifecycle.then(job); lifecycle = result.catch(() => {}); return result;
}
async function exportWork(job) {
  if (exporting) throw new Error('正在导出，请稍候。');
  exporting = true;
  try { return await job(); } finally { exporting = false; }
}
async function assertNoExport() {
  if (exporting || (await getExportTask())?.status === 'exporting') throw new Error('正在导出，请稍候。');
}
export async function getExportTask() {
  const task = (await chrome.storage.local.get('exportTask')).exportTask || null;
  // A restarted service worker cannot still own a previous download operation.
  if (task?.status === 'exporting' && !exporting) {
    task.status = 'failed'; task.error = '导出被中断，记录已保留，可以重试。';
    await chrome.storage.local.set({ exportTask: task });
  }
  return task;
}
async function beginExport(viewerTab, snapshot) {
  const createdAt = Date.now();
  const previous = (await chrome.storage.local.get('lastExportFolder')).lastExportFolder;
  const base = folderName(createdAt), folder = previous?.base === base ? `${base}-${previous.serial + 1}` : base;
  let finalShot = null;
  if (snapshot.parts.some(p => p.tabId === viewerTab.id)) {
    try { finalShot = await chrome.tabs.captureVisibleTab(viewerTab.windowId, { format: 'png' }); } catch {}
  }
  const task = { id: crypto.randomUUID(), runId: snapshot.runId, mode: snapshot.mode, status: 'exporting', createdAt, folder };
  const saved = { ...snapshot, createdAt, folder, finalShot };
  await chrome.storage.local.set({ exportSnapshot: saved, exportTask: task,
    lastExportFolder: { base, serial: previous?.base === base ? previous.serial + 1 : 1 } });
  return performExport(viewerTab, task, saved);
}
async function retryExport(viewerTab) {
  const { exportSnapshot: snapshot, exportTask: task } = await chrome.storage.local.get(['exportSnapshot', 'exportTask']);
  if (!snapshot || !task || task.status === 'complete') throw new Error('没有待重试的导出。');
  task.status = 'exporting'; delete task.error;
  await chrome.storage.local.set({ exportTask: task });
  return performExport(viewerTab, task, snapshot);
}
async function performExport(viewerTab, task, snapshot) {
  try {
    const result = await saveExport(viewerTab, snapshot.parts, snapshot, snapshot.note, snapshot);
    task.status = 'complete'; task.result = result;
    await chrome.storage.local.set({ exportTask: task });
    if (task.mode === 'manual') {
      const session = await getSession();
      if (String(session?.startedAt) === task.runId) { session.lastExport = result; await setSession(session); }
    } else {
      const run = await getContinuousRun();
      if (run?.id === task.runId) { run.lastExport = result; await chrome.storage.local.set({ continuousRun: run }); }
    }
    await chrome.storage.local.remove('exportSnapshot');
    return result;
  } catch (error) {
    task.status = 'failed'; task.error = error.message;
    await chrome.storage.local.set({ exportTask: task });
    throw error;
  }
}
