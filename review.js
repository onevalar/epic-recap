const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const id = params.get('id'), tabId = Number(params.get('tab'));
let draft, preview, result, busy = false, saveQueue = Promise.resolve(), previewTimer, version = 0, savedVersion = 0;
let editing, editorSource, editorTrigger, dragStart, history = [];
const canvas = $('editor-canvas'), context = canvas.getContext('2d');
const time = t => new Date(t).toLocaleTimeString('zh-CN', { hour12:false });
async function call(name, options = {}) {
  const response = await chrome.runtime.sendMessage({ type:'command', name, tabId, options:{ id, ...options } });
  if (!response?.ok) throw new Error(response?.error || '插件后台未响应，请重新打开检查页。');
  return response.result;
}
function error(err) { $('error').textContent=err.message || String(err); $('error').hidden=false; }
function announce(text) { $('announcements').textContent=text; }
function updateButton() { $('export').disabled=busy || Boolean(result) || !draft?.reviewed || savedVersion!==version; }
function settings() {
  return { note:draft.note, expected:draft.expected, redactions:draft.redactions, includeBodies:draft.includeBodies,
    includedShots:[...draft.includedShots], includedVideos:[...draft.includedVideos] };
}
function save(changes = settings()) {
  const current=++version;
  draft.reviewed=Object.keys(changes).length===1 && changes.reviewed===true;
  $('reviewed').checked=draft.reviewed; updateButton();
  if(Object.keys(changes).some(k=>k!=='reviewed')){$('result').hidden=true;$('retry').hidden=true;result=null;}
  $('save-status').textContent='正在保存到本机…';
  const pending=Object.keys(changes).every(k=>k==='reviewed')?saveQueue:saveQueue.catch(()=>{});
  saveQueue=pending.then(async()=>{
    const response=await call('save-review',{changes});
    savedVersion=current;
    if(current===version){draft.reviewed=response.reviewed;$('reviewed').checked=draft.reviewed;$('save-status').textContent='已保存到本机';$('error').hidden=true;updateButton();}
  });
  saveQueue.catch(err=>{if(current===version){draft.reviewed=false;$('reviewed').checked=false;$('save-status').textContent='保存失败，请修改内容后重试；当前不可导出';updateButton();}error(err);});
  clearTimeout(previewTimer);previewTimer=setTimeout(refreshPreview,250);
  return saveQueue;
}
async function refreshPreview() {
  const current=version;
  try {
    await saveQueue;
    const next=await call('preview-review');
    if(current!==version)return;
    preview=next;$('report').textContent=next.markdown;$('report-view').replaceChildren(...renderMarkdown(next.markdown));
    $('file-count').textContent=`共 ${next.files.length} 个文件`;
    $('attachment-count').textContent=`已选择 ${next.shotCount} 张截图 · ${next.videoCount} 段视频`;
    $('footer-summary').textContent=`将附带 ${next.shotCount} 张截图 · ${next.videoCount} 段视频`;
    $('file-list').replaceChildren(...next.files.map(name=>{const li=document.createElement('li');li.textContent=name;return li;}));
  } catch(err){error(err);}
}
function element(tag, className, text) {const n=document.createElement(tag);if(className)n.className=className;if(text)n.textContent=text;return n;}
// Renders the subset of Markdown that report.js writes. Built from text nodes only:
// recorded page content must never become markup.
function renderMarkdown(markdown) {
  const lines=markdown.split('\n'), out=[];
  const inline=text=>{
    const parts=[], pattern=/\*\*([^*]+)\*\*|`([^`]+)`/g;let last=0,m;
    while((m=pattern.exec(text))){parts.push(text.slice(last,m.index),m[1]?element('strong','',m[1]):element('code','',m[2]));last=pattern.lastIndex;}
    parts.push(text.slice(last));return parts.filter(x=>x!=='');
  };
  const block=(tag,text)=>{const n=element(tag);n.append(...inline(text));return n;};
  const cells=row=>row.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|'));
  const special=line=>/^(`{3,}|#{1,4} |> |\| |- |\d+\. )/.test(line);
  for(let i=0;i<lines.length;){
    const raw=lines[i], line=raw.trim();
    if(!line){i++;continue;}
    const fence=line.match(/^`{3,}/);
    if(fence){
      const indent=raw.length-raw.trimStart().length, body=[];
      for(i++;i<lines.length&&lines[i].trim()!==fence[0];i++)body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`),''));
      i++;const pre=element('pre');pre.append(element('code','',body.join('\n')));out.push(pre);continue;
    }
    const heading=line.match(/^(#{1,4}) (.*)$/);
    if(heading){out.push(block(`h${heading[1].length+2}`,heading[2]));i++;continue;}
    if(line.startsWith('> ')){
      const quote=element('blockquote');
      for(;i<lines.length&&lines[i].trim().startsWith('> ');i++)quote.append(block('p',lines[i].trim().slice(2)));
      out.push(quote);continue;
    }
    if(line.startsWith('| ')&&/^\|\s*---/.test(lines[i+1]?.trim()||'')){
      const table=element('table'),head=element('tr');
      for(const c of cells(line))head.append(block('th',c));
      table.append(element('thead'));table.firstChild.append(head);const body=element('tbody');
      for(i+=2;i<lines.length&&lines[i].trim().startsWith('|');i++){const tr=element('tr');for(const c of cells(lines[i]))tr.append(block('td',c));body.append(tr);}
      table.append(body);const wrap=element('div','table-wrap');wrap.append(table);out.push(wrap);continue;
    }
    const item=line.match(/^(- |(\d+)\. )(.*)$/);
    if(item){
      const list=element(item[2]?'ol':'ul');if(item[2])list.start=Number(item[2]);
      for(;i<lines.length;i++){const m=lines[i].trim().match(/^(- |(\d+)\. )(.*)$/);if(!m||Boolean(m[2])!==Boolean(item[2]))break;list.append(block('li',m[3]));}
      out.push(list);continue;
    }
    const paragraph=element('p');
    for(let first=true;i<lines.length&&lines[i].trim()&&(first||!special(lines[i].trim()));i++,first=false){
      if(!first)paragraph.append(element('br'));paragraph.append(...inline(lines[i].trim()));
    }
    out.push(paragraph);
  }
  return out;
}
for(const [button,rendered] of [['show-rendered',true],['show-raw',false]]){
  $(button).onclick=()=>{
    $('report-view').hidden=!rendered;$('report').hidden=rendered;
    $('show-rendered').setAttribute('aria-pressed',String(rendered));$('show-raw').setAttribute('aria-pressed',String(!rendered));
  };
}
function renderMedia() {
  const nodes=[];
  for(const part of draft.snapshot.parts){
    const media=[...part.shots.map(s=>({key:`${part.tabId}:${s.id}`,shot:s,url:draft.shotEdits[`${part.tabId}:${s.id}`]||s.dataUrl,t:s.t})),
      ...(part.video?.url||part.video?.error?[{key:String(part.tabId),video:true,url:part.video.url,t:part.video.startedAt,error:part.video.error}]:[]),
      ...(part.clips||[]).map(c=>({key:`clip:${c.id}`,video:true,url:c.url,t:c.startedAt,end:c.endedAt,error:c.error}))];
    for(const item of media){
      const card=element('article','media-item');
      const visual=element(!item.url?'p':item.video?'video':'img');
      if(item.url)visual.src=item.url;
      if(!item.url){visual.className='small error';visual.textContent=item.error;}
      else if(item.video){visual.controls=true;visual.preload='metadata';visual.playsInline=true;}
      else{visual.alt=`${part.meta.title || '页面'}，${time(item.t)} 的截图`;visual.loading='lazy';}
      const label=element('label','check-line');
      const checkbox=element('input');checkbox.type='checkbox';checkbox.id=`media-${item.key}`;
      const list=item.video?'includedVideos':'includedShots';checkbox.checked=draft[list].includes(item.key);
      checkbox.onchange=()=>{draft[list]=checkbox.checked?[...draft[list],item.key]:draft[list].filter(k=>k!==item.key);save();};
      const text=element('span','media-label',`${item.video?'视频':'截图'} · ${time(item.t)}${item.end?` 至 ${time(item.end)}`:''}`);
      text.append(element('small','',part.meta.title || '未命名页面'));label.append(checkbox,text);card.append(visual,label);
      if(!item.video){const edit=element('button','btn secondary',draft.shotEdits[item.key]?'查看或调整遮挡':'查看并遮挡');edit.type='button';edit.onclick=()=>openEditor(item,edit).catch(error);card.append(edit);}
      nodes.push(card);
    }
  }
  $('media-list').replaceChildren(...(nodes.length?nodes:[element('p','media-empty','这段记录没有可附带的画面，仍可导出文字报告。')]));
}
async function openEditor(item, trigger) {
  editing=item;editorTrigger=trigger;
  const image=new Image();image.src=draft.shotEdits[item.key]||item.shot.dataUrl;await image.decode();
  canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;context.drawImage(image,0,0);editorSource=canvas.toDataURL('image/png');
  history=[];$('undo-mask').disabled=true;
  $('editor-status').textContent='尚未添加新的遮挡。';$('image-editor').showModal();$('close-editor').focus();
}
function mask(x,y,w,h) {
  const left=Math.max(0,Math.min(x,x+w)),top=Math.max(0,Math.min(y,y+h));
  const width=Math.min(canvas.width,Math.max(x,x+w))-left,height=Math.min(canvas.height,Math.max(y,y+h))-top;
  if(width<1||height<1)return;
  remember();context.fillStyle='#000';context.fillRect(left,top,width,height);editorSource=canvas.toDataURL('image/png');
  $('editor-status').textContent='已添加不透明遮挡。保存后只导出处理过的图片。';
}
function remember(){history.push(editorSource);$('undo-mask').disabled=false;}
async function draw(source){const image=new Image();image.src=source;await image.decode();context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0);editorSource=canvas.toDataURL('image/png');}
$('undo-mask').onclick=async()=>{
  await draw(history.pop());$('undo-mask').disabled=!history.length;
  $('editor-status').textContent='已撤销上一步。';
};
function point(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};}
canvas.onpointerdown=e=>{if(e.button!==0)return;dragStart=point(e);canvas.setPointerCapture(e.pointerId);};
canvas.onpointerup=e=>{if(!dragStart)return;const end=point(e);mask(dragStart.x,dragStart.y,end.x-dragStart.x,end.y-dragStart.y);dragStart=null;};
canvas.onpointercancel=()=>{dragStart=null;};
$('mask-rectangle').onclick=()=>{
  const values=['x','y','w','h'].map(k=>$(`rect-${k}`));
  if(!values.every(n=>n.reportValidity()))return;
  const [x,y,w,h]=values.map(n=>Number(n.value)/100);mask(x*canvas.width,y*canvas.height,w*canvas.width,h*canvas.height);
};
$('reset-image').onclick=async()=>{
  remember();await draw(editing.shot.dataUrl);$('editor-status').textContent='已还原原图，可撤销；保存前请重新检查敏感内容。';
};
$('close-editor').onclick=()=>$('image-editor').close();
$('image-editor').onclose=()=>{dragStart=null;editorTrigger?.focus();};
$('image-editor').onkeydown=event=>{
  if(event.key!=='Tab')return;
  const controls=[...$('image-editor').querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
};
$('save-image').onclick=async()=>{
  $('save-image').disabled=true;
  try{
    const included=[...new Set([...draft.includedShots,editing.key])];
    await save({...settings(),includedShots:included,shotEdit:{key:editing.key,dataUrl:editorSource}});
    draft.shotEdits[editing.key]=editorSource;draft.includedShots=included;
    $('image-editor').close();renderMedia();
    document.getElementById(`media-${editing.key}`)?.focus();announce('遮挡已保存，截图已加入导出。');
  }catch(err){error(err);}finally{$('save-image').disabled=false;}
};
for(const key of ['note','expected','redactions']){
  $(key).oninput=()=>{draft[key]=$(key).value;save();};
}
$('include-bodies').onchange=()=>{draft.includeBodies=$('include-bodies').checked;save();};
$('reviewed').onchange=()=>save({reviewed:$('reviewed').checked});
async function exportZip(retry=false){
  if(busy)return;busy=true;updateButton();$('retry').disabled=true;$('error').hidden=true;
  $('export').textContent='正在打包并保存…';announce('正在打包并保存，可以关闭此页，记录不会删除。');
  for(const control of document.querySelectorAll('#content input,#content textarea,.media-item button'))control.disabled=true;
  try{await saveQueue;result=await call('export-reviewed',{retry});showResult(result);$('retry').hidden=true;}
  catch(err){error(err);const latest=await call('get-review').catch(()=>null);$('retry').hidden=latest?.task?.status!=='failed';}
  finally{busy=false;if(!result)for(const control of document.querySelectorAll('#content input,#content textarea,.media-item button'))control.disabled=false;$('retry').disabled=false;$('export').textContent=result?'已导出':'导出 ZIP';updateButton();}
}
// The export ends the recording task, so this draft can no longer change.
function showResult(value){result=value;$('result').hidden=false;$('result-path').textContent=value.folder;
  for(const control of document.querySelectorAll('#content input,#content textarea,.media-item button'))control.disabled=true;
  $('export').textContent='已导出';updateButton();document.querySelector('.review-footer').hidden=true;announce('ZIP 已保存，可以打开文件夹或复制给 AI 的说明。');}
$('export').onclick=()=>exportZip();$('retry').onclick=()=>exportZip(true);
$('show-folder').onclick=()=>chrome.downloads.show(result.reportId).catch(()=>chrome.downloads.showDefaultFolder());
$('copy-ai').onclick=async()=>{try{await navigator.clipboard.writeText(result.aiText);$('copy-ai').textContent='说明已复制';announce('请把说明与所选附件一起发送。');}catch{error(new Error('无法自动复制，请从报告预览中选择文字复制。'));}};
$('return').onclick=async()=>{await saveQueue.catch(()=>{});location.href=chrome.runtime.getURL(`popup.html?tab=${tabId}`);};
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!changes.reviewDraft)return;
  const next=changes.reviewDraft.newValue;
  // A finished export ends the task and removes the draft; the result stays on screen.
  if(!next&&(busy||result))return;
  if(!next||next.id!==id){$('content').hidden=true;$('image-editor').close();error(new Error('这份检查草稿已关闭或已被更新的片段替换，请返回记录重新打开。'));return;}
  if(savedVersion===version && !busy){
    draft=next;
    for(const key of ['note','expected','redactions'])if(document.activeElement!==$(key))$(key).value=draft[key];
    $('include-bodies').checked=draft.includeBodies;$('reviewed').checked=draft.reviewed;updateButton();refreshPreview();
  }
});
try{
  draft=await call('get-review');
  for(const key of ['note','expected','redactions'])$(key).value=draft[key];
  $('include-bodies').checked=draft.includeBodies;$('reviewed').checked=draft.reviewed;
  const recording=draft.snapshot.recording;
  $('period').textContent=`${draft.snapshot.parts.length} 个页面 · ${time(recording.startedAt)} 至 ${time(recording.rangeEnd||recording.stoppedAt)} · 检查期间不会改变这份片段`;
  $('content').hidden=false;renderMedia();await refreshPreview();updateButton();
  if(draft.task?.reviewId===id){
    if(draft.task.status==='complete')showResult(draft.task.result);
    if(draft.task.status==='failed'){error(new Error(draft.task.error));$('retry').hidden=false;}
    if(draft.task.status==='exporting'){
      busy=true;updateButton();$('export').textContent='正在打包并保存…';
      const timer=setInterval(async()=>{try{const latest=await call('get-review');if(latest.task?.status==='exporting')return;clearInterval(timer);busy=false;$('export').textContent='导出 ZIP';updateButton();if(latest.task?.status==='complete')showResult(latest.task.result);else{error(new Error(latest.task?.error||'导出中断，请重试。'));$('retry').hidden=false;}}catch(err){clearInterval(timer);error(err);}},1000);
    }
  }
}catch(err){error(err);$('period').textContent='无法打开这份检查草稿';}
