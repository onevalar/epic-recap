// Collectors that run in the extension itself rather than in the page:
// key-moment screenshots, every network request the browser makes for the tab,
// system CPU / memory samples, and events pages hand over when they unload.
// Per-tab data lives in chrome.storage.local (cleared on browser start); the
// recording flag lives in chrome.storage.session. Continuous recordings are cut
// into segments, which are kept per site in chrome.storage.local.

export const MAX_MINUTES = 10;
export const SEGMENT_MINUTES = 5;
export const MAX_SEGMENTS = 10;
const SHOT_LIMITS = { manual: { max: 18, reserved: 6 }, continuous: { max: 12, reserved: 4 } };
const MIN_SHOT_GAP = 1000; // Chrome allows about two captures per second
const MAX_NET = 5000;
const MAX_SWITCHES = 1000;
const MAX_PERF = 200;
const MASK = '******';
const SENSITIVE = /authorization|cookie|token|secret|passw|pwd|api[-_]?key|session|credential|csrf|xsrf/i;

const KEY = {
  rec: (tab) => `rec:${tab}`,
  shots: (tab) => `shots:${tab}`,
  shot: (tab, id) => `shot:${tab}:${id}`,
  net: (tab) => `net:${tab}`,
  perf: (tab) => `perf:${tab}`,
  device: (tab) => `device:${tab}`,
  handover: (tab) => `cur:${tab}`,
  segments: (origin) => `segs:${origin}`,
  segment: (id) => `seg:${id}`,
  segmentShot: (id, shotId) => `segshot:${id}:${shotId}`,
};
const PER_TAB_PREFIXES = ['shots:', 'shot:', 'net:', 'perf:', 'device:', 'cur:', 'switches'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = chrome.storage.local;
const getOne = async (key, fallback) => (await local.get(key))[key] ?? fallback;

// Storage writes are read-modify-write, so they all go through one queue.
let queue = Promise.resolve();
export const enqueue = (job) => {
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
};

// ---------- recording flag ----------

export async function getRecording(tabId) {
  const rec = (await chrome.storage.session.get(KEY.rec(tabId)))[KEY.rec(tabId)];
  if (!rec) return null;
  return rec.mode === 'continuous' || Date.now() < rec.startedAt + MAX_MINUTES * 60000 ? rec : null;
}

export const setRecording = (tabId, rec) => chrome.storage.session.set({ [KEY.rec(tabId)]: rec });
export const clearRecording = (tabId) => chrome.storage.session.remove(KEY.rec(tabId));

// Every tab currently recording, as [{ tabId, ...rec }].
export async function recordingTabsList(mode) {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith('rec:') && (!mode || v.mode === mode))
    .map(([k, v]) => ({ tabId: Number(k.slice(4)), ...v }));
}

// The manual recording session (one at a time; it may span several tabs).
export const getSession = async () => (await chrome.storage.session.get('session')).session || null;
export const setSession = (session) => (session ? chrome.storage.session.set({ session }) : chrome.storage.session.remove('session'));

export function clearCollected(tabId) {
  return enqueue(async () => {
    netBuffer.delete(tabId);
    lastCpu.delete(tabId);
    lastShot.delete(tabId);
    const list = await getOne(KEY.shots(tabId), []);
    await local.remove([
      KEY.shots(tabId), ...list.map((s) => KEY.shot(tabId, s.id)),
      KEY.net(tabId), KEY.perf(tabId), KEY.device(tabId), KEY.handover(tabId),
    ]);
  });
}

// Per-tab data from a previous browser session belongs to tabs that no longer exist.
export async function clearAllTabData() {
  const keys = Object.keys(await local.get(null)).filter((k) => PER_TAB_PREFIXES.some((p) => k.startsWith(p)));
  await local.remove(keys);
}

// ---------- screenshots ----------

const lastShot = new Map();

export function handleShotRequest(tab, req) {
  enqueue(() => takeShot(tab.id, req));
}

async function takeShot(tabId, { id, problem }) {
  const rec = await getRecording(tabId);
  if (!rec) return;
  const limit = SHOT_LIMITS[rec.mode] || SHOT_LIMITS.manual;
  const list = await getOne(KEY.shots(tabId), []);
  if (list.length >= limit.max || (!problem && list.length >= limit.max - limit.reserved)) return;
  const wait = (lastShot.get(tabId) || 0) + MIN_SHOT_GAP - Date.now();
  if (wait > 0) {
    if (!problem) return;
    await sleep(wait);
  }
  // Only the tab the user is looking at can be captured.
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) return;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
  lastShot.set(tabId, Date.now());
  await local.set({
    [KEY.shot(tabId, id)]: dataUrl,
    [KEY.shots(tabId)]: [...list, { id, t: Date.now(), problem: Boolean(problem) }],
  });
}

export async function getShots(tabId) {
  const list = await getOne(KEY.shots(tabId), []);
  const images = await local.get(list.map((s) => KEY.shot(tabId, s.id)));
  return list.map((s) => ({ ...s, dataUrl: images[KEY.shot(tabId, s.id)] })).filter((s) => s.dataUrl);
}

export async function countShots(tabId) {
  return (await getOne(KEY.shots(tabId), [])).length;
}

// ---------- every network request (webRequest) ----------

const recordingTabs = new Set();
const ready = chrome.storage.session.get(null).then((all) => {
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('rec:') && (v.mode === 'continuous' || Date.now() < v.startedAt + MAX_MINUTES * 60000)) recordingTabs.add(Number(k.slice(4)));
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (!k.startsWith('rec:')) continue;
    const tabId = Number(k.slice(4));
    if (newValue) recordingTabs.add(tabId); else recordingTabs.delete(tabId);
  }
});

function redactUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (SENSITIVE.test(k)) url.searchParams.set(k, MASK);
    const s = url.href;
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch { return u; }
}

function headerObject(list) {
  const out = {};
  for (const { name, value } of list || []) out[name] = SENSITIVE.test(name) ? MASK : value;
  return out;
}

const pending = new Map();
const netBuffer = new Map();
let flushTimer;

export async function onBeforeRequest(d) {
  await ready;
  if (!recordingTabs.has(d.tabId)) return;
  pending.set(d.requestId, {
    t: Math.round(d.timeStamp), method: d.method, url: redactUrl(d.url), type: d.type,
    inFrame: d.frameId !== 0, initiator: d.initiator,
  });
}

export async function onSendHeaders(d) {
  await ready;
  const p = pending.get(d.requestId);
  if (p) p.requestHeaders = headerObject(d.requestHeaders);
}

export async function onCompleted(d) {
  await ready;
  finish(d, { status: d.statusCode, fromCache: d.fromCache, ip: d.ip, responseHeaders: d.responseHeaders });
}

export async function onErrorOccurred(d) {
  await ready;
  finish(d, { error: d.error });
}

function finish(d, extra) {
  const p = pending.get(d.requestId);
  if (!p) return;
  pending.delete(d.requestId);
  const entry = { ...p, ...extra, duration: Math.round(d.timeStamp - p.t) };
  entry.failed = Boolean(entry.error) || entry.status >= 400;
  // Headers are only worth keeping for the requests that went wrong.
  if (entry.failed) entry.responseHeaders = headerObject(extra.responseHeaders);
  else { delete entry.requestHeaders; delete entry.responseHeaders; }
  if (!netBuffer.has(d.tabId)) netBuffer.set(d.tabId, []);
  netBuffer.get(d.tabId).push(entry);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNetwork, 1000);
}

export function flushNetwork() {
  clearTimeout(flushTimer);
  return enqueue(async () => {
    for (const [tabId, entries] of netBuffer) {
      netBuffer.delete(tabId);
      const list = (await getOne(KEY.net(tabId), [])).concat(entries);
      while (list.length > MAX_NET) {
        const i = list.findIndex((e) => !e.failed);
        list.splice(i === -1 ? 0 : i, 1);
      }
      await local.set({ [KEY.net(tabId)]: list });
    }
  });
}

// ---------- CPU / memory ----------

const lastCpu = new Map();

export function handleTick(tab, { heapUsed, heapLimit, device }) {
  enqueue(async () => {
    if (!(await getRecording(tab.id))) return;
    const [cpu, mem] = await Promise.all([chrome.system.cpu.getInfo(), chrome.system.memory.getInfo()]);
    const totals = cpu.processors.reduce(
      (sum, p) => ({ busy: sum.busy + p.usage.total - p.usage.idle, total: sum.total + p.usage.total }),
      { busy: 0, total: 0 },
    );
    const prev = lastCpu.get(tab.id);
    lastCpu.set(tab.id, totals);
    const sample = {
      t: Date.now(),
      cpuPercent: prev && totals.total > prev.total ? Math.round((100 * (totals.busy - prev.busy)) / (totals.total - prev.total)) : null,
      memAvailable: mem.availableCapacity,
      heapUsed: heapUsed ?? null,
    };
    const perf = (await getOne(KEY.perf(tab.id), [])).concat(sample).slice(-MAX_PERF);
    await local.set({
      [KEY.perf(tab.id)]: perf,
      [KEY.device(tab.id)]: {
        cpuModel: cpu.modelName, cpuCores: cpu.numOfProcessors, arch: cpu.archName,
        memTotal: mem.capacity, heapLimit: heapLimit ?? null, ...device,
      },
    });
  });
}

// ---------- events handed over by unloading pages ----------

export function handleHandover(tab, frameId, { events, isTop, url, title }) {
  enqueue(async () => {
    // Accept them while the tab records, or (stopped, not yet exported) while it belongs to the session.
    const rec = await getRecording(tab.id);
    const session = await getSession();
    const startedAt = rec?.startedAt ?? (session?.tabs[tab.id] ? session.startedAt : null);
    if (startedAt == null) return;
    const saved = await getOne(KEY.handover(tab.id), { events: [], page: null });
    const known = new Set(saved.events.map((e) => e.id));
    for (const e of events) {
      if (e.t < startedAt || known.has(e.id)) continue;
      saved.events.push(isTop ? e : { ...e, frame: url });
    }
    if (isTop && frameId === 0) saved.page = { url, title };
    await local.set({ [KEY.handover(tab.id)]: saved });
  });
}

export async function getCollected(tabId) {
  await flushNetwork();
  const s = await local.get([KEY.net(tabId), KEY.perf(tabId), KEY.device(tabId), KEY.handover(tabId)]);
  return {
    net: s[KEY.net(tabId)] || [],
    perf: s[KEY.perf(tabId)] || [],
    device: s[KEY.device(tabId)] || null,
    handover: s[KEY.handover(tabId)] || { events: [], page: null },
  };
}

// ---------- switching between recorded tabs ----------

export function recordSwitch(entry) {
  return enqueue(async () => {
    const list = (await getOne('switches', [])).concat(entry).slice(-MAX_SWITCHES);
    await local.set({ switches: list });
  });
}

export async function getSwitches(from, to = Date.now()) {
  return (await getOne('switches', [])).filter((s) => s.t >= from && s.t <= to);
}

// ---------- continuous-mode segments, kept per site ----------

export async function getContinuousSites() {
  return getOne('continuousSites', {});
}

export async function setContinuousSite(origin, on) {
  const sites = await getContinuousSites();
  if (on) sites[origin] = true; else delete sites[origin];
  await local.set({ continuousSites: sites });
}

export const listSegments = (origin) => getOne(KEY.segments(origin), []);

// `segment` carries its screenshots with image data; they are stored separately.
export function saveSegment(origin, segment) {
  return enqueue(async () => {
    const { shots, ...data } = segment;
    const index = await getOne(KEY.segments(origin), []);
    index.push({ id: segment.id, tabId: segment.tabId, startedAt: segment.startedAt, endedAt: segment.endedAt, title: segment.meta?.title, counts: segment.counts });
    const removed = index.splice(0, Math.max(0, index.length - MAX_SEGMENTS));
    await local.set({
      [KEY.segments(origin)]: index,
      [KEY.segment(segment.id)]: { ...data, shots: shots.map(({ dataUrl, ...s }) => s) },
      ...Object.fromEntries(shots.map((s) => [KEY.segmentShot(segment.id, s.id), s.dataUrl])),
    });
    for (const old of removed) await removeSegmentData(old.id);
  });
}

async function removeSegmentData(id) {
  const seg = await getOne(KEY.segment(id), null);
  await local.remove([KEY.segment(id), ...(seg?.shots || []).map((s) => KEY.segmentShot(id, s.id))]);
}

export async function loadSegment(id) {
  const seg = await getOne(KEY.segment(id), null);
  if (!seg) return null;
  const images = await local.get(seg.shots.map((s) => KEY.segmentShot(id, s.id)));
  return { ...seg, shots: seg.shots.map((s) => ({ ...s, dataUrl: images[KEY.segmentShot(id, s.id)] })).filter((s) => s.dataUrl) };
}

export function clearSegments(origin) {
  return enqueue(async () => {
    for (const s of await getOne(KEY.segments(origin), [])) await removeSegmentData(s.id);
    await local.remove(KEY.segments(origin));
  });
}

export async function segmentBytes(origin) {
  const index = await listSegments(origin);
  if (!index.length) return 0;
  const keys = [KEY.segments(origin)];
  for (const s of index) {
    keys.push(KEY.segment(s.id));
    const seg = await getOne(KEY.segment(s.id), null);
    for (const shot of seg?.shots || []) keys.push(KEY.segmentShot(s.id, shot.id));
  }
  return local.getBytesInUse(keys);
}
