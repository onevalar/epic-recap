const app = document.getElementById('app');
const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabId = Number(new URLSearchParams(location.search).get('tab')) || activeTab?.id;
const prefs = await chrome.storage.local.get('prefVideo');
const { dismissedExportId } = await chrome.storage.session.get('dismissedExportId');
const ui = { route: null, video: prefs.prefVideo === true, continuous: false, multi: false,
  picked: new Set(), sites: new Set(), query: '', mode: null, dismissed: dismissedExportId,
  markerNote: '', coverage: null,
  message: '', notice: '', tone: '', busy: false, initialized: false };
let state = null, candidates = [], refreshing = false, lastCandidatesAt = 0, signature = '';
let pendingFocus = null;
const shortcuts = Object.fromEntries((await chrome.commands.getAll().catch(() => [])).map(c => [c.name, c.shortcut]));
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
const brand = () => el('header', { className:'brand' }, el('img', { src:'assets/07f59.png', width:24, height:24, alt:'' }), el('h1', { textContent:'Recap' }));
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
const READ_COMMANDS = new Set(['state', 'coverage', 'video-authorize']);
async function call(name, options = {}) {
  // The backend can lose the first message while waking up after being idle.
  // Read-only commands are bounded and retry once, so the popup never hangs on
  // the loader; mutating commands still run exactly once.
  const attempt = () => {
    const send = chrome.runtime.sendMessage({ type:'command', name, tabId, options });
    send.catch(() => {});
    return Promise.race([send, new Promise(r => setTimeout(() => r(undefined), 8000))]);
  };
  let r;
  if (READ_COMMANDS.has(name)) {
    r = await attempt().catch(() => undefined);
    if (!r) r = await attempt().catch(() => undefined);
    if (!r) throw new Error('插件后台没有响应，请重新打开面板。');
  } else {
    r = await attempt();
  }
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
  }
  if (ui.route) return ui.route;
  if (state.session?.active) return state.session.isMember ? 'recording' : 'other';
  if (state.session) return 'stopped';
  if (state.continuous?.active) return 'continuous';
  if (state.continuous) return 'stopped';
  return ui.multi ? 'config' : 'home';
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
    if (ui.route === 'continuous' && !next.continuous?.active) ui.route = null;
    if (['home','config'].includes(ui.route) && (next.session || next.continuous)) ui.route = null;
    if (['stopped','discard','exporting','exportError'].includes(ui.route) && !next.session && !next.continuous) ui.route = null;
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
// Errors stay until the next action; confirmations fade on their own so they never outlive their screen.
function notify(text, tone) {
  ui.message = text; ui.notice = text; ui.tone = tone;
  setTimeout(() => { if (ui.message === text) { ui.message = ''; render(true); } }, 4000);
}
function showMessage() {
  if (!ui.message) return null;
  const tone = ui.message === ui.notice ? ui.tone : 'warning';
  return el('p', { className:`message ${tone}`, textContent:ui.message, role:tone === 'warning' ? 'alert' : 'status' });
}
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
// Each home entry only picks the flow; recording starts from its configuration page.
function openConfig(continuous) { ui.continuous=continuous; ui.multi=true; ui.query=''; ui.coverage=null; navigate('config'); refresh(true); updateCoverage(); }
async function updateCoverage() {
  if (!ui.continuous) return;
  const origins = [...ui.sites];
  try {
    const coverage = await call('coverage', { origins });
    if (JSON.stringify(origins) !== JSON.stringify([...ui.sites])) return;
    ui.coverage = coverage; render(true);
  } catch (err) { ui.message = err.message; render(true); }
}
function homeView() {
  const entry = (continuous, label, description) => el('button', { type:'button', className:'entry', id:continuous?'entry-continuous':'entry-manual',
    disabled:ui.busy, onclick:() => openConfig(continuous) }, stack(p(label,'entry-title'), p(description,'small muted')), icon('chevron'));
  return [brand(),
    entry(false, '单次录制', '现在复现问题：开始、复现、停止，最长 10 分钟'),
    entry(true, '持续录制', '挂在后台，出问题后停止，导出停止前 30 分钟')];
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
function configView() {
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
  return [nav(ui.continuous?'持续录制':'单次录制', () => { ui.multi=false; navigate('home'); }),
    p(ui.continuous?'选择要记录的站点，最多同时记录 4 个页面。':'选择要录制的页面，最多 4 个；最长 10 分钟，到时自动停止。','small muted'),
    el('div', { className:'search' },icon('search'),search),row(p(`已选择 ${picked.size} / ${state.limits.tabs}`,'medium semibold grow'),p(picked.size===state.limits.tabs?'已达上限':`最多 ${state.limits.tabs} 个`,'small muted')),list,
    el('div', { className:'picker-footer' },el('div',{className:'divider'}),
      ui.continuous ? p(ui.coverage?`实际记录 ${ui.coverage.selected.length} 个页面，${ui.coverage.waiting.length} 个等待。优先覆盖每个站点，当前页优先。`:'同时记录最多 4 个页面；每个站点优先覆盖。','small muted') : null,
      setting(ui.continuous?'视频（只录当前页面）':'视频（含页面声音）',ui.video,setVideo,{id:'video'}),
      ui.continuous&&ui.coverage?.selected.length?el('details',{},el('summary',{textContent:'查看实际记录页面'}),...ui.coverage.selected.map(t=>p(t.title,'small'))):null,
      ui.continuous&&ui.video?p(`视频只录当前页面，保留最近 ${state.limits.videoKeepMinutes} 分钟。`,'small muted'):null,
      button(!picked.size?(ui.continuous?'选择站点后开启':'选择页面后开始'):ui.continuous?'开启持续录制':'开始录制',()=>run(start),'primary',!picked.size,'start'))];
}
async function start() {
  const result = ui.continuous ? await call('continuous-on', { origins:[...ui.sites], video:ui.video })
    : await call('start', { tabIds:[...ui.picked], video:ui.video });
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
    const mark=await call('mark',{note:ui.markerNote});ui.markerNote='';notify(`已标记 ${hhmm(mark.t)}，报告会突出这一刻。`,'success');
  }),'secondary',!enabled,'mark-problem'),
    enabled&&(state.markers?.length||shortcuts['mark-problem'])?p([state.markers?.length?`已保留 ${state.markers.length} 个问题标记`:'',shortcuts['mark-problem']?`按 ${shortcuts['mark-problem']} 可直接标记`:''].filter(Boolean).join(' · '),'small muted'):null);
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
  const status=row(badge('单次录制中','recording'),p(other?`${s.members.length} 个页面`:s.members.length===1?'当前页面':`${s.members.length} 个页面`,'small muted grow'),
    other?p(mmss(Date.now()-s.startedAt),'medium semibold'):s.members.length===1&&s.members[0].video==='waiting'?el('button',{type:'button',className:'badge warning',textContent:'重新授权视频',onclick:()=>run(()=>call('video-authorize'))}):s.videoTabs?icon('videoOn'):s.members.length===1?badge('未录制视频'):null);
  if(other) return [brand(),status,identity(),p('此页面未加入记录','page-title'),
    full?p('已达 4 个页面上限','medium muted'):!state.pageReady?p(state.origin?'刷新页面后即可加入':'此页面不支持记录','medium muted'):null,
    button('把此页面加入记录',()=>run(async()=>{await call('join'); ui.route=null;}),'primary',full||!state.pageReady),
    !full&&!state.pageReady&&state.origin?button('去刷新页面',()=>focusTab(tabId),'secondary'):null,
    button('查看正在录制的页面',()=>navigate('recording','manual'),'secondary'),button('停止录制',()=>run(()=>stop('manual')),'quiet')];
  return [!s.isMember?nav('正在记录的页面',()=>navigate('other','manual')):brand(),status,
    el('div',{className:'time-block'},p(mmss(Date.now()-s.startedAt),'time'),p('10 分钟自动停止','small muted')),
    s.members.length===1 && s.isMember ? identity() : members(),
    metrics(s.totals),markerControl(s.isMember),button('停止录制',()=>run(()=>stop('manual')),'stop')];
}
// Stopping goes straight to the review page; the popup keeps the task until it is exported.
async function stop(which) {
  await call(which==='manual'?'stop':'continuous-off');
  ui.mode=which; ui.route='stopped';
  await openReview();
}
function continuousView() {
  const c=state.continuous;
  return [brand(),badge(c.recording.length?'持续录制中':'等待页面',c.recording.length?'continuous':'warning'),
    el('div',{className:'time-block'},p(c.oldest?`${hhmm(c.oldest)} — ${hhmm(c.newest || Date.now())}`:'暂无记录','window'),p(`已保留的范围；停止后导出最近 ${state.limits.videoKeepMinutes} 分钟`,'small muted')),
    el('div',{className:'card site-list'},...c.origins.map(o => row(icon('siteSmall'),p(o.host,'medium semibold grow ellipsis'),badge(o.count?`${o.count} 个记录${o.waiting?` · ${o.waiting} 个等待`:''}`:'尚未记录',o.count?'':'warning')))),
    c.inGroup&&!c.thisTabRecording ? p(c.full?'已达 4 个页面上限，当前页未记录。':state.pageReady?'此页面等待接入记录。':'刷新当前页面后可继续记录。','small muted') : null,
    !c.inGroup?p('当前页面不在记录范围内。','small muted'):null,
    c.waiting?.length?p('等待页面将在空出名额后自动加入。','small muted'):null,
    c.recording.length?metrics(c.totals):null,
    c.video&&c.active?el('div',{className:'card video-status'},row(icon(c.videoTab?'videoOn':'video'),
      p(c.videoTab?`视频：${c.videoTab.title||c.videoTab.label}`:'视频未在录制','medium semibold grow ellipsis'),c.videoTab?badge('录制中','recording'):null),
      c.videoError?p(c.videoError,'small error'):null,
      p(c.videoTab?`已保留 ${Math.min(c.videoKeepMinutes,Math.floor(c.videoKeptMs/60000))} 分钟 · ${Math.round(c.videoBytes/1048576)} MB；最多保留最近 ${c.videoKeepMinutes} 分钟。`:'在正在记录的页面上打开插件，即可从该页开始录制。','small muted')):null,
    markerControl(c.thisTabRecording),
    button('停止录制并导出',()=>run(()=>stop('continuous')),'stop',false,'stop-continuous')];
}
function summary(which=mode()) {
  const s=which==='manual'?state.session:state.continuous;
  const from=s.oldest&&Math.max(s.oldest,(s.newest||s.stoppedAt)-state.limits.videoKeepMinutes*60000);
  const duration=which==='manual'?mmss(s.stoppedAt-s.startedAt):s.oldest?`${hhmm(from)} — ${hhmm(s.newest || s.stoppedAt)}`:'暂无记录';
  const count=which==='manual'?s.members.length:s.pageCount;
  const video=which==='manual'?(s.videoTabs?`含 ${s.videoTabs} 段视频`:'未录制视频'):s.video?'事件、截图与视频':'事件与截图';
  return el('div',{className:'card summary'},row(p(which==='manual'?'单次录制':'持续录制','medium semibold grow'),p(duration,'small muted')),
    p(`${count} 个页面 · ${video}`,'medium muted'),p(`页面报错 ${s.totals.errors||0} · 失败请求 ${s.totals.failedRequests||0}`,'small'));
}
function stoppedView() {
  const s=subject();
  return [brand(),badge('待导出','warning'),el('h2',{textContent:s.recovered?'已找回上次录制':'这次录制还没导出'}),summary(),
    s.recovered?p(s.stopReason==='restart'?'已恢复到最后一次自动保存；意外关闭前尚未保存的操作及未完成视频可能缺失。':'可以继续检查并导出，不需要重新复现问题。','small muted'):null,
    ...(s.members||[]).filter(m=>m.videoError).map(m=>p(m.videoError,'small error')),
    s.stopReason==='auto'?p('已到 10 分钟，自动停止','small muted'):null,
    p('在检查页补充说明、确认隐私后导出 ZIP。导出完成后这次录制即结束。','small muted'),
    actions(button(state.reviewOpen?'回到检查页':'检查并导出',()=>run(openReview),'primary',mode()==='continuous'&&!s.oldest,'open-review'),
      button('放弃这次录制',()=>navigate('discard'),'text'))];
}
async function openReview() {
  await call('prepare-review',{mode:mode()});
  notify('已打开检查页；关闭这个面板不会丢失录制。','info');
}
async function dismissTask() {
  ui.dismissed=state.exportTask?.id; await chrome.storage.session.set({dismissedExportId:ui.dismissed});
}
async function retryExport() {
  ui.mode=mode();ui.route='exporting';render(true);
  try {
    await call(state.exportTask?.reviewId?'export-reviewed':ui.mode==='manual'?'export':'export-range',{id:state.exportTask?.reviewId,retry:true});
    ui.route=null;
  } catch(err) {
    const s=await call('state');state=s;
    ui.route=s.exportTask?.status==='failed'?'exportError':'stopped';
    throw err;
  }
}
function exportView(failed=false) {
  if(!failed)return [brand(),el('div',{className:'success-block',role:'status'},el('div',{className:'spinner','aria-hidden':'true'}),el('h3',{textContent:'正在导出…'}),p('整理记录与附件','medium muted')),button('正在导出…',null,'primary',true)];
  return [brand(),badge('导出未完成','warning'),el('h3',{textContent:'下载未完成'}),p('记录已保留，可以重试。','muted'),
    p(state.exportTask?.error||ui.message,'small muted'),actions(button('重试导出',()=>run(retryExport)),button('返回检查页',()=>run(async()=>{await dismissTask();ui.route='stopped';await openReview();}),'quiet'))];
}
async function reset(discard) {
  const which=mode();await call(which==='manual'?'close':'continuous-close',{discard});
  ui.markerNote='';ui.route=null;ui.mode=null;ui.continuous=false;ui.multi=false;ui.picked=new Set(state.pageReady?[tabId]:[]);ui.sites=new Set(state.origin?[state.origin]:[]);
}
function discardView() {
  return [brand(),badge('放弃录制','warning'),el('h3',{textContent:'放弃这次录制？'}),p('录制的内容和说明将被删除，无法恢复。','muted'),
    button('返回，保留录制',()=>navigate('stopped'),'secondary'),button('放弃',()=>run(()=>reset(true)),'danger')];
}
function render(force=false) {
  const current=route();
  if(app.dataset.view&&app.dataset.view!==current&&ui.message===ui.notice)ui.message='';
  // Typing and range selection do not rerender from live sampling updates.
  const data=['stopped','discard','exporting','exportError'].includes(current)
    ?{run:subject()?.startedAt,active:subject()?.active,task:state?.exportTask,reviewOpen:state?.reviewOpen}
    :state&&{tabId:state.tabId,title:state.title,url:state.url,origin:state.origin,pageReady:state.pageReady,markers:state.markers,
      session:state.session&&{...state.session,totals:{errors:state.session.totals.errors,failedRequests:state.session.totals.failedRequests}},
      continuous:state.continuous&&{...state.continuous,newest:state.continuous.newest&&hhmm(state.continuous.newest)}};
  const next=JSON.stringify({current,data,video:ui.video,continuous:ui.continuous,multi:ui.multi,query:ui.query,
    picked:[...ui.picked],sites:[...ui.sites],coverage:ui.coverage,message:ui.message,busy:ui.busy,candidates:current==='config'?candidates:null});
  if(!force&&next===signature){for(const t of app.querySelectorAll('.time'))if(state?.session)t.textContent=mmss(Date.now()-state.session.startedAt);return;}
  signature=next;
  const focused=document.activeElement, focusId=focused?.id || pendingFocus, position=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const changedView=app.dataset.view&&app.dataset.view!==current;
  if(focusId)pendingFocus=focusId;
  const scroll=app.querySelector('#candidates')?.scrollTop||0;
  let children;
  switch(current){
    case 'home':children=homeView();break;case 'config':children=configView();break;
    case 'recording':children=manualView();break;case 'other':children=manualView(true);break;
    case 'continuous':children=continuousView();break;case 'stopped':children=stoppedView();break;
    case 'exporting':children=exportView();break;case 'exportError':children=exportView(true);break;
    case 'discard':children=discardView();break;
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
  document.getElementById('announcements').textContent=ui.message||(changedView?({recording:'单次录制已开始',continuous:'持续录制已开始',stopped:'录制已停止，等待导出'}[current]||''):'');
}

// Video authorization only matters while a recording is active; the popup
// already surfaces a re-authorize control. Never block the first render on it:
// a swallowed wake-up message would otherwise stall the popup forever.
call('video-authorize').catch(() => {});
await refresh(true);
setInterval(()=>refresh(),1000);
