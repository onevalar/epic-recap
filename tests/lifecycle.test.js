import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Test the production lifecycle against an in-memory Chrome boundary.
const area = () => ({
 data: {},
 async get(keys) { const all = structuredClone(this.data); return keys == null ? all : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in all).map(k => [k, all[k]])); },
 async set(values) { Object.assign(this.data, structuredClone(values)); },
 async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete this.data[k]; },
});
const local = area(), session = area();
let downloads, downloadState, videos, videoStarts;
globalThis.chrome = {
 storage: { local, session, onChanged: { addListener() {} } },
 alarms: { clear: async () => true },
 action: { setBadgeText: async () => {} },
 offscreen: { hasDocument: async () => Boolean(Object.keys(videos).length), createDocument: async () => {} },
 tabCapture: { getMediaStreamId: async ({ targetTabId }) => { videoStarts.push(targetTabId); return 'stream'; } },
 runtime: { sendMessage: async ({ type, tabId }) => {
  if (type === 'video-start') videos[tabId] = { recording: true };
  return { ok: true, ...videos[tabId] };
 } },
 tabs: { captureVisibleTab: async () => { throw Error('no active tab'); } },
 downloads: {
  setUiOptions: async () => {}, erase: async () => [],
  download: async options => { const id = downloads.length + 1; downloads.push({ ...options, id, state: downloadState, error: 'NETWORK_FAILED' }); return id; },
  search: async () => downloads,
 },
};
const api = await import('../export.js');
const capture = await import('../capture.js');
const origin = 'http://localhost:3000';
const part = (time) => ({ id: '1-segment', origin, tabId: 1, startedAt: time - 30000, endedAt: time,
 meta: { title: '订单', url: `${origin}/`, dropped: 0, device: {} },
 events: [{ id: 'error', t: time - 1000, type: 'error', message: '保留的错误' }],
 net: [], perf: [], shots: [], device: null, counts: { errors: 1, failedRequests: 0 },
});
beforeEach(() => { local.data = {}; session.data = {}; downloads = []; downloadState = 'complete'; videos = {}; videoStarts = []; });

test('unexported manual data cannot be replaced or implicitly discarded', async () => {
 const existing = { startedAt: 1, stoppedAt: 2, tabs: {} };
 await capture.setSession(existing);
 await assert.rejects(api.startSession([1]), /导出或放弃/);
 await assert.rejects(api.closeSession(), /确认放弃/);
 assert.deepEqual(await capture.getSession(), existing);
 await api.closeSession({ discard: true });
 assert.equal(await capture.getSession(), null);
});

test('manual selection rejects more than four tabs before changing state', async () => {
 await assert.rejects(api.startSession([1, 2, 3, 4, 5]), /最多同时记录 4/);
 assert.equal(await capture.getSession(), null);
});

test('video authorization records every page, up to all four, and never restarts a running stream', async () => {
 await capture.setSession({ startedAt: Date.now(), video: true, tabs: { 1: {}, 2: {}, 3: {}, 4: {} } });
 videos[1] = { recording: true };
 for (const id of [1, 2, 3, 4]) await api.authorizeVideo(id);
 assert.deepEqual(videoStarts, [2, 3, 4]);
 assert.equal(Object.values(videos).filter(v => v.recording).length, 4);
});

test('stopping continuous recording retains segments and requires final export or explicit discard', async () => {
 const now = Date.now();
 await local.set({ continuousRun: { id: 'run', origins: [origin], startedAt: now - 60000, lastExport: { folder: 'older export' } } });
 await capture.setContinuousSite(origin, true);
 await capture.saveSegment(origin, part(now));
 await api.stopContinuousGroup();
 assert.equal((await capture.listSegments(origin)).length, 1);
 assert.deepEqual(await capture.getContinuousSites(), {});
 assert.equal((await api.getContinuousRun()).lastExport, undefined);
 await assert.rejects(api.closeContinuous(), /确认放弃/);
 await api.closeContinuous({ discard: true });
 assert.equal((await capture.listSegments(origin)).length, 0);
 assert.equal(await api.getContinuousRun(), null);
});

test('delayed stopped export uses the stop time; interrupted downloads retain a retryable snapshot', async () => {
 const stoppedAt = Date.now() - 30 * 60000;
 await local.set({ continuousRun: { id: 'run', origins: [origin], startedAt: stoppedAt - 60000, stoppedAt } });
 await capture.saveSegment(origin, part(stoppedAt));
 downloadState = 'interrupted';
 await assert.rejects(api.exportRange({ id: 1 }, { minutes: 5 }), /下载未完成/);
 const task = await api.getExportTask();
 const snapshot = (await local.get('exportSnapshot')).exportSnapshot;
 assert.equal(task.status, 'failed');
 assert.equal(snapshot.recording.rangeEnd, stoppedAt);
 assert.equal(snapshot.parts[0].events[0].message, '保留的错误');
 assert.equal((await api.getContinuousRun()).lastExport, undefined);
 downloadState = 'complete';
 const result = await api.exportRange({ id: 1 }, { retry: true });
 assert.equal(result.folder, task.folder);
 assert.equal(result.endedAt, stoppedAt);
 assert.equal((await api.getExportTask()).id, task.id);
 assert.equal((await local.get('exportSnapshot')).exportSnapshot, undefined);
 await api.closeContinuous();
 assert.equal(await api.getContinuousRun(), null);
});

test('service-worker restart makes an unfinished export retryable without deleting its snapshot', async () => {
 await local.set({ exportTask: { id: 'job', status: 'exporting' }, exportSnapshot: { note: '保留备注' } });
 assert.equal((await api.getExportTask()).status, 'failed');
 assert.equal((await local.get('exportSnapshot')).exportSnapshot.note, '保留备注');
});

test('lifecycle queue serializes changes and remains usable after a failure', async () => {
 const order = [];
 const first = api.withLifecycle(async () => { order.push('start'); await new Promise(r => setTimeout(r, 5)); order.push('end'); throw Error('expected'); });
 const second = api.withLifecycle(() => order.push('next'));
 await assert.rejects(first, /expected/); await second;
 assert.deepEqual(order, ['start', 'end', 'next']);
});
