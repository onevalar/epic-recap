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
let downloads, downloadState, videos, videoStarts, tabs;
globalThis.chrome = {
 storage: { local, session, onChanged: { addListener() {} } },
 alarms: { clear: async () => true, create: async () => {} },
 action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
 offscreen: { hasDocument: async () => Boolean(Object.keys(videos).length), createDocument: async () => {} },
 tabCapture: { getMediaStreamId: async ({ targetTabId }) => { videoStarts.push(targetTabId); return 'stream'; } },
 runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async ({ type, tabId }) => {
  if (type === 'video-start') videos[tabId] = { recording: true };
  return { ok: true, ...videos[tabId] };
 } },
 tabs: {
  captureVisibleTab: async () => { throw Error('no active tab'); },
  query: async () => structuredClone(tabs),
  get: async id => { const tab=tabs.find(t=>t.id===id);if(!tab)throw Error('closed');return tab; },
  create: async () => {},
 },
 scripting: { executeScript: async ({ target }) => {
  const tab=tabs.find(t=>t.id===target.tabId);if(!tab)throw Error('closed');
  return [{ frameId:0, result:{ actions:0,requests:0,errors:0,failedRequests:0,bytes:0,events:0,
    meta:{title:tab.title,url:tab.url,dropped:0}, ...('rec:'+tab.id in session.data?{events:[]}:{}),
  } }];
 } },
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
beforeEach(() => { local.data = {}; session.data = {}; downloads = []; downloadState = 'complete'; videos = {}; videoStarts = [];
 tabs=[{id:1,title:'订单',url:origin+'/'}]; });

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
 await session.set({ continuousRunId:'run' });
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

test('stopped and interrupted manual drafts remain exportable after browser session storage is lost', async () => {
 const savedAt=Date.now()-20000, savedPart=part(savedAt);
 for(const stoppedAt of [savedAt,undefined]) {
  await capture.setSession({startedAt:savedPart.startedAt,stoppedAt,tabs:{1:{title:'订单',url:origin+'/'}}});
  await local.set({manualArchive:{runId:String(savedPart.startedAt),parts:[savedPart],savedAt}});
  session.data={};
  const state=await api.getState(999);
  assert.equal(state.session.active,false);assert.equal(state.session.recovered,true);
  assert.equal(state.session.stoppedAt,savedAt);assert.equal(state.session.totals.errors,1);
  await api.exportSession({id:999},'重启前的订单问题');
  const report=decodeURIComponent(downloads.at(-1).url.split(',').slice(1).join(','));
  assert.match(report,/保留的错误/);assert.match(report,/重启前的订单问题/);
  await api.closeSession();assert.equal(await capture.getSession(),null);
 }
});

test('review defaults exclude media and bodies; explicit redaction and problem markers reach the exported preview', async () => {
 const now=Date.now(), savedPart=part(now);
 savedPart.events.push({id:'request',t:now-500,type:'network',method:'POST',url:origin+'/orders?token=PRIVATE_URL',status:500,
  requestBody:'{"token":"PRIVATE_JSON","item":"blue-shirt"}',responseBody:'customer=客户甲; token=PRIVATE_LOG; phone=13800000000'});
 savedPart.shots=[{id:'shot',t:now-1000,dataUrl:'data:image/png;base64,AAAA'}];
 await capture.setSession({startedAt:savedPart.startedAt,stoppedAt:now,tabs:{1:{}}});
 await local.set({manualArchive:{runId:String(savedPart.startedAt),parts:[savedPart],savedAt:now},
  problemMarks:{runId:String(savedPart.startedAt),entries:[{id:'mark',type:'marker',t:now-750,tab:'1',message:'点击后出错'}]}});
 const {id}=await api.prepareReview({id:1},{mode:'manual'});
 let preview=await api.previewReview(id);
 assert.equal(preview.shotCount,0);assert.doesNotMatch(preview.markdown,/blue-shirt|PRIVATE_URL|PRIVATE_JSON|PRIVATE_LOG|13800000000/);
 assert.match(preview.markdown,/## 问题标记/);assert.match(preview.markdown,/点击后出错/);
 await api.updateReview(id,{includeBodies:true,redactions:'客户甲',note:'客户甲提交订单',expected:'显示订单编号',includedShots:['1:shot']});
 preview=await api.previewReview(id);
 assert.equal(preview.shotCount,1);assert.match(preview.markdown,/blue-shirt/);assert.match(preview.markdown,/显示订单编号/);
 assert.doesNotMatch(preview.markdown,/客户甲|PRIVATE_URL|PRIVATE_JSON|PRIVATE_LOG|13800000000/);
 await api.updateReview(id,{reviewed:true});assert.equal((await api.getReview(id)).reviewed,true);
 await api.updateReview(id,{note:'修改说明'});assert.equal((await api.getReview(id)).reviewed,false);
 const reopened=await api.prepareReview({id:1},{mode:'manual'});assert.equal(reopened.id,id);
 assert.match((await api.previewReview(id)).markdown,/修改说明/);
 await assert.rejects(api.exportReviewed({id:1},{id}),/确认已经检查/);
});

test('continuous planning covers each site and backfills a freed slot without reloading the waiting tab', async () => {
 const second='http://localhost:4000';
 tabs=[1,2,3,4].map(id=>({id,title:`订单 ${id}`,url:origin+'/'})).concat({id:5,title:'后台',url:second+'/'});
 await api.startContinuousGroup([origin,second],5);
 let state=await api.getState(5);
 assert.equal(state.continuous.thisTabRecording,true);assert.equal(state.continuous.recording.length,4);
 assert.deepEqual(state.continuous.origins.map(o=>o.count),[3,1]);
 const waiting=state.continuous.waiting[0].tabId;
 const removed=state.continuous.recording.find(t=>t.origin===origin).tabId;
 tabs=tabs.filter(t=>t.id!==removed);
 await api.rotateSegment(removed,{restart:false});await api.fillContinuousSlots();
 state=await api.getState(waiting);assert.equal(state.continuous.thisTabRecording,true);
 assert.equal(state.continuous.recording.length,4);assert.equal(state.continuous.waiting.length,0);
});

test('continuous recovery does not replace completed segments with older checkpoints', async () => {
 const now=Date.now(), completed=part(now), older=part(now-10000);
 older.events=[];
 await local.set({continuousRun:{id:'run',origins:[origin],startedAt:now-60000},
  continuousCheckpoint:{runId:'run',savedAt:now-10000,parts:[older]}});
 await capture.saveSegment(origin,completed);
 const state=await api.getState(1);
 assert.equal(state.continuous.active,false);assert.equal(state.continuous.recovered,true);
 assert.equal(state.continuous.totals.errors,1);assert.equal(state.continuous.stoppedAt,now);
 const {id}=await api.prepareReview({id:1},{mode:'continuous',minutes:0});
 assert.match((await api.previewReview(id)).markdown,/保留的错误/);
});

test('changed review content invalidates a failed export; unavailable selected videos cannot silently disappear', async () => {
 const now=Date.now(), savedPart=part(now);
 await capture.setSession({startedAt:savedPart.startedAt,stoppedAt:now,tabs:{1:{}}});
 videos[1]={url:'blob:original',size:4096,startedAt:now-30000};
 await local.set({manualArchive:{runId:String(savedPart.startedAt),parts:[savedPart],savedAt:now}});
 const {id}=await api.prepareReview({id:1},{mode:'manual'});
 await api.updateReview(id,{includedVideos:['1']});await api.updateReview(id,{reviewed:true});
 videos={};
 await assert.rejects(api.previewReview(id),/视频已不可用/);
 await api.updateReview(id,{includedVideos:[]});
 assert.equal((await api.previewReview(id)).videoCount,0);
 await local.set({exportTask:{id:'old',runId:String(savedPart.startedAt),reviewId:id,status:'failed'},exportSnapshot:{note:'old'}});
 await api.updateReview(id,{redactions:'新增的隐私内容'});
 assert.equal(await api.getExportTask(),null);assert.equal((await api.getReview(id)).reviewed,false);
 await assert.rejects(api.exportReviewed({id:1},{id,retry:true}),/没有这份草稿/);
});
