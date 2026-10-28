const app = document.getElementById('app');
const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabId = Number(new URLSearchParams(location.search).get('tab')) || activeTab?.id;
const prefs = await chrome.storage.local.get(['prefVideo', 'manualNote', 'continuousNote', 'manualExpected', 'continuousExpected']);
const { dismissedExportId } = await chrome.storage.session.get('dismissedExportId');
const ui = { route: null, video: prefs.prefVideo === true, continuous: false, multi: false,
  picked: new Set(), sites: new Set(), query: '', range: 10, mode: null, dismissed: dismissedExportId,
  notes: { manual: prefs.manualNote || '', continuous: prefs.continuousNote || '' },
  expected: { manual: prefs.manualExpected || '', continuous: prefs.continuousExpected || '' },
  markerNote: '', coverage: null,
  message: '', busy: false, initialized: false, exportResult: null, confirmFrom: null };
let state = null, candidates = [], refreshing = false, lastCandidatesAt = 0, signature = '';
let pendingFocus = null;
const pad = n => String(n).padStart(2, '0');
const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const hhmm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('aria-') || key === 'role') n.setAttribute(key, value);
    else n[key] = value;
  }
  n.append(...children.flat().filter(x => x !== null && x !== undefined && x !== false)); return n;
}
const iconFiles = { site:['7e11e.svg',20], tabs:['e9399.svg',20], chevron:['4bc67.svg',20], arrow:['d6349.svg',20], search:['6cc81.svg',20], video:['c96b0.svg',16], videoOn:['7efe2.svg',16], siteSmall:['f14a3.svg',16], check:['c4860.svg',20], clock:['be191.svg',16], success:['6b956.svg',24] };
function icon(name) { const [file,size] = iconFiles[name]; return el('img', { className:'icon', src:`assets/${file}`, alt:'', width:size, height:size }); }
const p = (text, cls = '') => el('p', { className:cls, textContent:text });
const row = (...children) => el('div', { className:'row' }, ...children);
const stack = (...children) => el('div', { className:'stack' }, ...children);
const actions = (...children) => el('div', { className:'actions' }, ...children);
const badge = (text, kind = '') => el('span', { className:`badge ${kind}`, textContent:text });
const brand = () => el('header', { className:'brand' }, el('img', { src:'assets/07f59.png', width:24, height:24, alt:'' }), el('h1', { textContent:'Epic Recap' }));
function button(label, action, kind = 'primary', disabled = false, id = '') {
  return el('button', { type:'button', className:`btn ${kind}`, textContent:label, disabled:disabled || ui.busy, id:id || `button-${label}`, onclick:action });
}
function nav(label, action) { return el('button', { type:'button', className:'nav', onclick:action, disabled:ui.busy }, icon('arrow'), label); }
function host(url) { try { return new URL(url).host || url; } catch { return url || ''; } }
function identity(info = state) {
  return el('div', { className:'page-identity' }, el('div', { className:'site-icon' }, icon('site')),
    el('div', { className:'grow' }, p(info.title || info.label || '当前页面', 'page-title ellipsis'), p(host(info.url), 'small muted ellipsis')));
}
function setting(label, checked, change, {disabled=false, id=''} = {}) {
  const input = el('input', { type:'checkbox', checked, disabled:disabled || ui.busy, id, 'aria-label':label,
    onchange:() => change(input.checked) });
  return el('label', { className:`setting${disabled?' disabled':''}` }, p(label, 'grow'), input);
}
async function call(name, options = {}) {
  const r = await chrome.runtime.sendMessage({ type:'command', name, tabId, options });
  if (!r?.ok) throw new Error(r?.error || '插件后台没有响应，请重新打开面板。');
  return r.result;
}
function navigate(route, mode = ui.mode) { ui.route = route; ui.mode = mode; ui.message = ''; render(true); }
function mode() { return ui.mode || (state?.session ? 'manual' : 'continuous'); }
function subject() { return mode() === 'manual' ? state?.session : state?.continuous; }
function route() {
  if (!state) return 'loading';
  const task = state.exportTask;
  if (task && task.id !== ui.dismissed) {
    if (task.status === 'exporting') return 'exporting';
    if (task.status === 'failed') return 'exportError';
    if (task.status === 'complete') return 'success';
  }
  if (ui.route) return ui.route;
  if (state.session?.active) return state.session.isMember ? 'recording' : 'other';
  if (state.session) return 'stopped';
  if (state.continuous?.active) return 'continuous';
  if (state.continuous) return 'stopped';
  return ui.multi ? 'multi' : 'home';
}
async function run(job) {
  if (ui.busy) return;
  ui.busy = true; ui.message = ''; render(true);
  try { await job(); } catch (err) { ui.message = err.message; }
  finally { ui.busy = false; await refresh(); render(true); }
}
async function refresh(forceCandidates = false) {
  if (refreshing || ui.busy && !forceCandidates) return;
  refreshing = true;
  try {
    const withCandidates = forceCandidates || (!state || (!state.session && !state.continuous && Date.now()-lastCandidatesAt > 5000));
    const next = await call('state', { candidates:withCandidates });
    if (withCandidates) { candidates = next.candidates; lastCandidatesAt = Date.now(); }
    state = next;
    // Another popup, the keyboard shortcut, or the ten-minute timer can change the run.
    if (next.session) ui.mode = 'manual';
    else if (next.continuous) ui.mode = 'continuous';
    if (['recording','other'].includes(ui.route) && !next.session?.active) ui.route = null;
    if (['continuous','range'].includes(ui.route) && !next.continuous?.active) { ui.route = null; ui.range = 0; }
    if (['home','multi'].includes(ui.route) && (next.session || next.continuous)) ui.route = null;
    if (['stopped','note','discard'].includes(ui.route) && !next.session && !next.continuous) ui.route = null;
    if (!ui.initialized) {
      if (next.pageReady && next.origin) { ui.picked.add(next.tabId); ui.sites.add(next.origin); }
      ui.initialized = true;
    }
    if (withCandidates) {
      for (const id of ui.picked) if (!candidates.some(c => c.tabId === id && c.available)) ui.picked.delete(id);
      for (const origin of ui.sites) if (!candidates.some(c => c.origin === origin && c.available)) ui.sites.delete(origin);
    }
    if (!ui.route && next.exportTask && next.exportTask.id !== ui.dismissed) ui.mode = next.exportTask.mode;
  } catch (err) { ui.message = err.message; }
  finally { refreshing = false; render(); }
}
function showMessage() { return ui.message ? el('p', { className:'message', textContent:ui.message }) : null; }
function setVideo(on) {
  ui.video = on; chrome.storage.local.set({ prefVideo:on }).catch(err => { ui.message=err.message; render(true); }); render(true);
}
async function focusTab(id) {
  try {
    const tab = await chrome.tabs.get(id);
    await chrome.windows.update(tab.windowId, { focused:true });
    await chrome.tabs.update(id, { active:true }); window.close();
  } catch { ui.message='页面已关闭。'; await refresh(); }
}
function openPicker() { ui.multi=true; ui.query=''; navigate('multi'); refresh(true); updateCoverage(); }
async function updateCoverage() {
  if (!ui.continuous) return;
  const origins = ui.multi ? [...ui.sites] : [state.origin];
  try {
    const coverage = await call('coverage', { origins });
    if (JSON.stringify(origins) !== JSON.stringify(ui.multi ? [...ui.sites] : [state.origin])) return;
    ui.coverage = coverage; render(true);
  } catch (err) { ui.message = err.message; render(true); }
}
function homeView() {
  const ready = state.pageReady && state.origin;
  const modes = el('fieldset', { className:'mode-options' }, el('legend', { className:'sr-only', textContent:'记录方式' }),
    ...[[false,'manual','复现问题','手动开始与停止，最长 10 分钟'],[true,'continuous','等待偶发问题','持续回溯，较早内容覆盖，不含视频']].map(([continuous,id,label,description]) =>
      el('label',{className:'mode-option'},el('input',{type:'radio',name:'mode',id,checked:ui.continuous===continuous,
        onchange:()=>{ui.continuous=continuous;render(true);updateCoverage();}}),stack(p(label,'semibold'),p(description,'small muted')))));
  return [brand(), identity(), modes,
    setting(ui.continuous?'视频在此模式下不可用':'视频（含页面声音）',ui.continuous?false:ui.video,setVideo,{disabled:ui.continuous,id:'video'}),
    el('button', { className:'link-row', id:'choose-pages', type:'button', onclick:openPicker },icon('tabs'),p(ui.continuous?'选择多个站点':'同时记录多个页面','grow'),icon('chevron')),
    ui.continuous&&ui.coverage?p(`将记录 ${ui.coverage.selected.length} 个页面${ui.coverage.waiting.length?`，${ui.coverage.waiting.length} 个等待名额`:''}；空位自动补入。`,'small muted'):null,
    p('仅保存在本机。记录操作、请求、日志与截图；分享前可检查、遮挡或移除附件。','small muted'),
    button(ready?'开始记录':state.origin?'刷新页面后开始':'此页面无法记录',()=>run(start),'primary',!ready,'start'),
    !ready&&state.origin?button('返回页面，手动刷新',()=>focusTab(tabId),'quiet'):null];
}
function siteCandidates() {
  const groups = new Map();
  for (const c of candidates) {
    if (!c.origin) continue;
    if (!groups.has(c.origin)) groups.set(c.origin, { origin:c.origin, title:host(c.origin), url:c.origin, ready:false, count:0 });
    const site = groups.get(c.origin); site.count++; site.ready ||= c.available;
  }
  return [...groups.values()].map(s => ({...s, available:s.ready, reason:s.ready?`${s.count} 个已打开页面`:'需刷新页面后才能记录'}));
}
function multiView() {
  const choices = ui.continuous ? siteCandidates() : candidates;
  const picked = ui.continuous ? ui.sites : ui.picked;
  const search = el('input', { id:'search', type:'search', placeholder:'搜索页面或网址', value:ui.query, 'aria-label':'搜索页面或网址',
    oninput:e => { ui.query=e.target.value; render(true); } });
  const visible = choices.filter(c => `${c.title} ${c.url}`.toLowerCase().includes(ui.query.toLowerCase()));
  const list = el('div', { className:'picker', id:'candidates', 'aria-label':ui.continuous?'站点列表':'页面列表' });
  for (const c of visible) {
    const key = ui.continuous ? c.origin : c.tabId, on = picked.has(key);
    const disabled = !c.available || (!on && picked.size >= state.limits.tabs);
    const input = el('input', { type:'checkbox', checked:on, disabled:disabled || ui.busy, id:`candidate-${key}`, 'aria-label':c.title || c.label,
      onchange:() => { if (input.checked) picked.add(key); else picked.delete(key); render(true); updateCoverage(); } });
    const subtitle = !c.available || ui.continuous ? c.reason : `${host(c.url)}${c.current?' · 当前页面':''}`;
    list.append(el('label', { className:'candidate', title:c.url }, input, el('div', { className:'grow' },
      p(c.title || c.label || '未命名页面', 'candidate-title ellipsis'), p(subtitle,'small muted ellipsis'))));
  }
  if (!visible.length) list.append(p(ui.query?'没有匹配的页面':'暂无可选择的页面','empty'));
  return [nav(ui.continuous?'选择站点':'选择页面', () => { ui.multi=false; navigate('home'); }),
    el('div', { className:'search' },icon('search'),search),row(p(`已选择 ${picked.size} / ${state.limits.tabs}`,'medium semibold grow'),p(picked.size===state.limits.tabs?'已达上限':`最多 ${state.limits.tabs} 个`,'small muted')),list,
    el('div', { className:'picker-footer' },el('div',{className:'divider'}),
      ui.continuous ? p(ui.coverage?`实际记录 ${ui.coverage.selected.length} 个页面，${ui.coverage.waiting.length} 个等待。优先覆盖每个站点，当前页优先。`:'同时记录最多 4 个页面；每个站点优先覆盖。','small muted') : setting('视频（含页面声音）',ui.video,setVideo,{id:'multi-video'}),
      ui.continuous&&ui.coverage?.selected.length?el('details',{},el('summary',{textContent:'查看实际记录页面'}),...ui.coverage.selected.map(t=>p(t.title,'small'))):null,
      button(picked.size?`开始记录 · ${picked.size} 个${ui.continuous?'站点':'页面'}`:'选择页面后开始',()=>run(start),'primary',!picked.size,'start'))];
}
async function start() {
  const result = ui.continuous ? await call('continuous-on', { origins:ui.multi?[...ui.sites]:[state.origin] })
    : await call('start', { tabIds:ui.multi?[...ui.picked]:[tabId], video:ui.video });
  ui.route=null; ui.mode=ui.continuous?'continuous':'manual'; ui.multi=false; ui.query='';
  if (result.problems?.length) ui.message=result.problems.join('；');
}
function metrics(t = {}) {
  return el('div',{className:'metric-grid'},...[[t.errors||0,'页面报错'],[t.failedRequests||0,'失败请求']].map(([value,label]) =>
    el('div',{className:'metric'},el('strong',{textContent:value}),p(label,'small muted'))));
}
function markerControl(enabled) {
  const input = el('input',{id:'marker-note',className:'text-input',placeholder:'补充一句说明（可选）',value:ui.markerNote,maxLength:500,'aria-label':'问题标记说明',
    oninput:e=>{ui.markerNote=e.target.value;}});
  return stack(input,button('标记问题发生在这里',()=>run(async()=>{
    const mark=await call('mark',{note:ui.markerNote});ui.markerNote='';ui.message=`已标记 ${hhmm(mark.t)}，报告会突出这一刻。`;
  }),'secondary',!enabled,'mark-problem'),state.markers?.length?p(`已保留 ${state.markers.length} 个问题标记`,'small muted'):null);
}
function members() {
  const s=state.session;
  return el('div',{className:'card member-list'},...s.members.map(m => {
    const labels={recording:'视频录制中',done:'视频已录制',waiting:'待授权',limit:'未录制视频',off:'未录制视频'};
    const label=m.closed?'已结束':labels[m.video];
    let status=badge(label,m.video==='recording'?'recording':m.video==='waiting'&&!m.closed?'warning':'');
    if(m.video==='waiting'&&!m.closed) status=el('button',{type:'button',className:'badge warning',textContent:m.tabId===tabId?'重新授权视频':'待授权',
      title:'切换到该页面后，再次点击插件图标以授权视频',onclick:()=>m.tabId===tabId?run(()=>call('video-authorize')):focusTab(m.tabId)});
    return row(p(m.title || m.label,'member-name grow ellipsis'),status);
  }));
}
function manualView(other=false) {
  const s=state.session, full=s.members.length>=state.limits.tabs;
  const status=row(badge('记录中','recording'),p(other?`${s.members.length} 个页面`:s.members.length===1?'当前页面':`${s.members.length} 个页面`,'small muted grow'),
    other?p(mmss(Date.now()-s.startedAt),'medium semibold'):s.members.length===1&&s.members[0].video==='waiting'?el('button',{type:'button',className:'badge warning',textContent:'重新授权视频',onclick:()=>run(()=>call('video-authorize'))}):s.videoTabs?icon('videoOn'):s.members.length===1?badge('未录制视频'):null);
  if(other) return [brand(),status,identity(),p('此页面未加入记录','page-title'),
    full?p('已达 4 个页面上限','medium muted'):!state.pageReady?p(state.origin?'刷新页面后即可加入':'此页面不支持记录','medium muted'):null,
    button('把此页面加入记录',()=>run(async()=>{await call('join'); ui.route=null;}),'primary',full||!state.pageReady),
    !full&&!state.pageReady&&state.origin?button('去刷新页面',()=>focusTab(tabId),'secondary'):null,
    button('查看正在记录的页面',()=>navigate('recording','manual'),'secondary'),button('停止记录',()=>run(()=>stop('manual')),'stop')];
  return [!s.isMember?nav('正在记录的页面',()=>navigate('other','manual')):brand(),status,
    el('div',{className:'time-block'},p(mmss(Date.now()-s.startedAt),'time'),p('10 分钟自动停止','small muted')),
    s.members.length===1 && s.isMember ? identity() : members(),
    metrics(s.totals),markerControl(s.isMember),button('停止记录',()=>run(()=>stop('manual')),'stop')];
}
async function stop(which) {
  await call(which==='manual'?'stop':'continuous-off');
  ui.mode=which; ui.route='stopped'; ui.exportResult=null;
  if(which==='continuous') ui.range=0;
}
function continuousView() {
  const c=state.continuous;
  return [brand(),badge(c.recording.length?'持续记录中':'等待页面',c.recording.length?'continuous':'warning'),
    el('div',{className:'time-block'},p(c.oldest?`${hhmm(c.oldest)} — ${hhmm(c.newest || Date.now())}`:'暂无记录','window'),p('当前可导出的时间范围','small muted')),
    el('div',{className:'card site-list'},...c.origins.map(o => row(icon('siteSmall'),p(o.host,'medium semibold grow ellipsis'),badge(o.count?`${o.count} 个记录${o.waiting?` · ${o.waiting} 个等待`:''}`:'尚未记录',o.count?'':'warning')))),
    c.inGroup&&!c.thisTabRecording ? p(c.full?'已达 4 个页面上限，当前页未记录。':state.pageReady?'此页面等待接入记录。':'刷新当前页面后可继续记录。','small muted') : null,
    !c.inGroup?p('当前页面不在记录范围内。','small muted'):null,
    c.waiting?.length?p('等待页面将在空出名额后自动加入。','small muted'):null,
    c.recording.length?metrics(c.totals):null,
    markerControl(c.thisTabRecording),
    actions(button('导出片段',()=>{ui.range=10;navigate('range','continuous');},'primary',!c.oldest),button('停止持续记录',()=>run(()=>stop('continuous')),'quiet'))];
}
function summary(which=mode()) {
  const s=which==='manual'?state.session:state.continuous;
  const duration=which==='manual'?mmss(s.stoppedAt-s.startedAt):s.oldest?`${hhmm(s.oldest)} — ${hhmm(s.newest || s.stoppedAt)}`:'暂无记录';
  const count=which==='manual'?s.members.length:s.pageCount;
  const video=which==='manual'?(s.videoTabs?`含 ${s.videoTabs} 段视频`:'未录制视频'):'事件与截图';
  return el('div',{className:'card summary'},row(p('本次记录','medium semibold grow'),p(duration,'small muted')),
    p(`${count} 个页面 · ${video}`,'medium muted'),p(`页面报错 ${s.totals.errors||0} · 失败请求 ${s.totals.failedRequests||0}`,'small'));
}
function stoppedView() {
  const s=subject();
  return [brand(),el('h2',{textContent:s.recovered?'已找回上次记录':'记录已保留'}),summary(),
    s.recovered?p(s.stopReason==='restart'?'已恢复到最后一次自动保存；意外关闭前尚未保存的操作及未完成视频可能缺失。':'可以继续检查并导出，不需要重新复现问题。','small muted'):null,
    ...(s.members||[]).filter(m=>m.videoError).map(m=>p(m.videoError,'small error')),
    s.stopReason==='auto'?p('已到 10 分钟，自动停止','small muted'):null,
    mode()==='continuous'?p('导出范围：全部可用记录','medium semibold'):null,
    problemFields(),
    actions(button('检查并导出',()=>run(openReview),'primary',mode()==='continuous'&&!s.oldest),
      button('放弃这次记录',()=>{ui.confirmFrom='stopped';navigate('discard');},'text'))];
}
function problemFields() {
  const which=mode();
  return stack(...[['note','发生了什么（可选）','例如：点击保存后一直转圈',ui.notes,which==='manual'?'manualNote':'continuousNote'],
    ['expected','预期怎样（可选）','例如：保存成功并返回列表',ui.expected,which==='manual'?'manualExpected':'continuousExpected']].map(([id,label,placeholder,values,key])=>
    stack(el('label',{htmlFor:id,className:'small semibold',textContent:label}),el('textarea',{id,className:'compact-note',value:values[which],placeholder,maxLength:10000,
      oninput:e=>{values[which]=e.target.value;chrome.storage.local.set({[key]:e.target.value}).catch(()=>{ui.message='说明未保存，请重试。';render(true);});}}))));
}
async function openReview() {
  await call('prepare-review',{mode:mode(),note:ui.notes[mode()],expected:ui.expected[mode()],minutes:state.continuous?.stoppedAt?0:ui.range});
  ui.message='已打开独立检查页，关闭面板不会丢失记录。';
}
function interval() {
  if(mode()==='manual')return `本次记录 · ${mmss(state.session.stoppedAt-state.session.startedAt)}`;
  const c=state.continuous, end=c.stoppedAt||Date.now(), start=ui.range?Math.max(c.oldest||end,end-ui.range*60000):c.oldest;
  return start?`${hhmm(start)} — ${hhmm(end)}`:'暂无可导出的记录';
}
function rangeView() {
  return [nav('导出片段',()=>navigate('continuous','continuous')),badge('记录仍在继续','continuous'),p('选择时间范围','medium semibold'),
    el('div',{className:'range-options'},...[5,10,20,0].map(minutes=>el('label',{className:'range-option'},
      el('input',{type:'radio',id:`range-${minutes}`,name:'range',value:minutes,checked:ui.range===minutes,onchange:()=>{ui.range=minutes;ui.message='';render(true);}}),
      p(minutes?`最近 ${minutes} 分钟`:'全部可用记录','grow'),icon('check')))),p(interval(),'medium semibold muted'),
    button('检查并导出',()=>run(openReview),'primary',!state.continuous.oldest)];
}
async function dismissTask() {
  ui.dismissed=state.exportTask?.id; await chrome.storage.session.set({dismissedExportId:ui.dismissed});
}
async function doExport() {
  ui.mode=mode();ui.route='exporting';render(true);
  try {
    ui.exportResult=await call(state.exportTask?.reviewId?'export-reviewed':ui.mode==='manual'?'export':'export-range',{id:state.exportTask?.reviewId,retry:true});
    ui.route='success';
  } catch(err) {
    ui.route=null;
    // Failed preparation (e.g. empty range) has no snapshot to retry.
    const s=await call('state');state=s;
    if(s.exportTask?.status==='failed')ui.route='exportError';
    else ui.route=ui.mode==='continuous'&&s.continuous?.active?'range':'stopped';
    throw err;
  }
}
function exportView(failed=false) {
  if(!failed)return [brand(),el('div',{className:'success-block',role:'status'},el('div',{className:'spinner','aria-hidden':'true'}),el('h3',{textContent:'正在导出…'}),p('整理记录与附件','medium muted')),button('正在导出…',null,'primary',true)];
  return [brand(),badge('导出未完成','warning'),el('h3',{textContent:'下载未完成'}),p('记录已保留，可以重试。','muted'),
    p(state.exportTask?.error||ui.message,'small muted'),actions(button('重试导出',()=>run(()=>doExport(false,true))),button('返回导出选项',()=>run(async()=>{await dismissTask();ui.route=mode()==='continuous'&&state.continuous.active?'range':'stopped';}),'quiet'))];
}
function successView() {
  const result=ui.exportResult || state.exportTask?.result || subject()?.lastExport;
  if(!result)return [brand(),p('记录已保留。'),button('返回记录',()=>navigate(null))];
  const continuing=result.mode==='continuous'&&state.continuous?.active;
  return [brand(),el('div',{className:'success-block'},el('div',{className:'success-icon'},icon('success')),el('h2',{textContent:'已导出'}),
      p(result.mode==='continuous'?`${hhmm(result.startedAt)} — ${hhmm(result.endedAt)}`:`本次记录 · ${mmss(result.endedAt-result.startedAt)}`,'medium muted'),continuing?badge('记录仍在继续','continuous'):null),
    el('div',{className:'card'},p(result.folder.replace('/',' /\n'),'folder'),p(result.contents?.join('、')||`${result.fileCount} 个文件`,'small muted')),
    button('打开文件夹',()=>chrome.downloads.show(result.reportId).catch(()=>chrome.downloads.showDefaultFolder()),'secondary'),
    result.aiText?button('复制给 AI 的说明',()=>run(async()=>{await navigator.clipboard.writeText(result.aiText);ui.message='已复制，请将说明和导出附件一起发送。';}),'secondary'):null,
    button(continuing?'返回记录':'开始新的记录',()=>run(async()=>{
      if(continuing){await dismissTask();ui.route='continuous';ui.exportResult=null;}
      else await reset(false);
    }))];
}
async function reset(discard) {
  const which=mode();await call(which==='manual'?'close':'continuous-close',{discard});
  ui.notes[which]='';ui.expected[which]='';ui.markerNote='';ui.route=null;ui.mode=null;ui.exportResult=null;ui.continuous=false;ui.multi=false;ui.picked=new Set(state.pageReady?[tabId]:[]);ui.sites=new Set(state.origin?[state.origin]:[]);
}
function discardView() {
  return [brand(),badge('放弃记录','warning'),el('h3',{textContent:'放弃这次记录？'}),p('已记录的内容和备注将被删除，无法恢复。','muted'),
    button('返回，保留记录',()=>navigate(ui.confirmFrom||'stopped'),'secondary'),button('放弃并开始新的记录',()=>run(()=>reset(true)),'danger')];
}
function render(force=false) {
  const current=route();
  // Typing and range selection do not rerender from live sampling updates.
  const data=['stopped','discard','range','success','exporting','exportError'].includes(current)
    ?{run:subject()?.startedAt,active:subject()?.active,task:state?.exportTask}
    :state&&{tabId:state.tabId,title:state.title,url:state.url,origin:state.origin,pageReady:state.pageReady,markers:state.markers,
      session:state.session&&{...state.session,totals:{errors:state.session.totals.errors,failedRequests:state.session.totals.failedRequests}},
      continuous:state.continuous&&{...state.continuous,newest:state.continuous.newest&&hhmm(state.continuous.newest)}};
  const next=JSON.stringify({current,data,video:ui.video,continuous:ui.continuous,multi:ui.multi,query:ui.query,range:ui.range,
    picked:[...ui.picked],sites:[...ui.sites],coverage:ui.coverage,message:ui.message,busy:ui.busy,candidates:current==='multi'?candidates:null});
  if(!force&&next===signature){for(const t of app.querySelectorAll('.time'))if(state?.session)t.textContent=mmss(Date.now()-state.session.startedAt);return;}
  signature=next;
  const focused=document.activeElement, focusId=focused?.id || pendingFocus, position=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const changedView=app.dataset.view&&app.dataset.view!==current;
  if(focusId)pendingFocus=focusId;
  const scroll=app.querySelector('#candidates')?.scrollTop||0;
  let children;
  switch(current){
    case 'home':children=homeView();break;case 'multi':children=multiView();break;
    case 'recording':children=manualView();break;case 'other':children=manualView(true);break;
    case 'continuous':children=continuousView();break;case 'stopped':children=stoppedView();break;
    case 'range':children=rangeView();break;
    case 'exporting':children=exportView();break;case 'exportError':children=exportView(true);break;
    case 'success':children=successView();break;case 'discard':children=discardView();break;
    default:children=[brand(),p(ui.message?'无法读取记录':'正在读取记录…','muted'),ui.message?button('重试',()=>refresh(true),'secondary'):null];
  }
  app.dataset.view=current;app.setAttribute('aria-busy',ui.busy?'true':'false');
  app.replaceChildren(...children.filter(Boolean),...((ui.message&&current!=='exportError')?[showMessage()]:[]));
  for(const n of app.querySelectorAll('button'))if(!n.id)n.id=`control-${n.textContent}`;
  const list=app.querySelector('#candidates');if(list)list.scrollTop=scroll;
  if(focusId){const n=document.getElementById(focusId);if(n&&!n.disabled){n.focus({preventScroll:true});pendingFocus=null;if(position&&n.setSelectionRange)try{n.setSelectionRange(...position);}catch{}}}
  if(changedView&&!ui.busy&&!app.contains(document.activeElement)){
    const heading=app.querySelector('h2,h1,.nav');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}pendingFocus=null;
  }
  document.getElementById('announcements').textContent=ui.message||(changedView?({recording:'记录已开始',continuous:'持续记录已开始',stopped:'记录已保存',success:'导出已完成'}[current]||''):'');
}

try { await call('video-authorize'); } catch { ui.message='视频未开启，页面数据仍在记录。'; }
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local')return;
  let changed=false;
  for(const which of ['manual','continuous']){
    if(changes[`${which}Note`]){ui.notes[which]=changes[`${which}Note`].newValue||'';changed=true;}
    if(changes[`${which}Expected`]){ui.expected[which]=changes[`${which}Expected`].newValue||'';changed=true;}
  }
  if(changed&&!['note','expected'].includes(document.activeElement?.id))render(true);
});
await refresh(true);
setInterval(()=>refresh(),1000);
