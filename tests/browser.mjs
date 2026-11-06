import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const suite=process.env.BROWSER_SUITE || 'all';
assert.ok(['all','recording','retry','limits','review'].includes(suite),`Unknown browser suite: ${suite}`);
const appDir=path.resolve(import.meta.dirname,'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'recap-browser-'));
const artifactDir=process.env.ARTIFACT_DIR || temp;await fs.mkdir(artifactDir,{recursive:true});
const downloadDir=path.join(temp,'downloads');await fs.mkdir(downloadDir);
await fs.mkdir(path.join(temp,'profile','Default'),{recursive:true});
await fs.writeFile(path.join(temp,'profile','Default','Preferences'),JSON.stringify({download:{default_directory:downloadDir,prompt_for_download:false}}));
const html=title=>`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><button id="action">提交订单</button><script>document.querySelector('button').onclick=()=>{console.error('订单失败');fetch('/fail').then(r=>r.json())};</script>`;
const servers=[];
async function serve(title){const s=http.createServer((req,res)=>{if(req.url==='/fail'){res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"test failure"}');}else{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html(title));}});await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s);return `http://127.0.0.1:${s.address().port}`;}
const [originA,originB]=await Promise.all([serve('订单管理'),serve('管理后台')]);
const browserPath=process.env.CHROMIUM_PATH;
let context;
const readyWorker=async()=>{
 const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 // The worker event can precede extension API/script initialization under parallel load.
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  if(await worker.evaluate(()=>Boolean(globalThis.epicTS)))return worker;
  await new Promise(r=>setTimeout(r,10));
 }
 throw new Error('Extension worker did not initialize');
};
const checks=[];
const passed=name=>{checks.push(name);console.log('PASS',name);};
try{
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,deviceScaleFactor:2,channel:browserPath?undefined:"chromium",executablePath:browserPath,
   args:[`--disable-extensions-except=${appDir}`,`--load-extension=${appDir}`],ignoreDefaultArgs:['--disable-extensions'],acceptDownloads:true,downloadsPath:downloadDir});
 let worker=await readyWorker();
 const extensionId=new URL(worker.url()).host;
 const a=await context.newPage();await a.goto(originA);
 const b=await context.newPage();await b.goto(originB);
 const api=async(name,tabId,options={})=>worker.evaluate(({name,tabId,options})=>globalThis.epicTS.runCommand({name,tabId,options}),{name,tabId,options});
 const tabs=await worker.evaluate(()=>chrome.tabs.query({}));
 const aid=tabs.find(t=>t.url.startsWith(originA)).id,bid=tabs.find(t=>t.url.startsWith(originB)).id;
 const popup=await context.newPage();await popup.setViewportSize({width:360,height:600});
 const errors=[];popup.on('pageerror',e=>errors.push(e.message));
 const open=async(id=aid)=>{await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${id}`);await popup.locator('#app:not([data-view="loading"])').waitFor();await popup.evaluate(()=>document.fonts.ready);};
 const waitView=async(v)=>popup.waitForFunction(v=>document.querySelector('#app')?.dataset.view===v,v,{timeout:15000});
 const click=async(label)=>popup.getByRole('button',{name:label,exact:true}).click();
 const screenshot=async(name)=>{await popup.evaluate(()=>window.scrollTo(0,0));const h=await popup.locator('#app').evaluate(n=>n.getBoundingClientRect().height);await popup.screenshot({path:path.join(artifactDir,`${name}.png`),clip:{x:0,y:0,width:360,height:Math.min(h,600)}});};
 // Stopping a recording opens its review page right away.
 const stopToReview=async(label='停止录制')=>{const created=context.waitForEvent('page');await click(label);return created;};
 const lastDownload=async()=>(await worker.evaluate(()=>chrome.downloads.search({orderBy:['-startTime']})))[0];
 const exportIn=async(review,success=true)=>{
  await review.waitForSelector('#content:not([hidden])');await review.waitForFunction(()=>document.getElementById('report').textContent.length>0);
  assert.equal(await review.locator('#export').isDisabled(),true);
  await review.setViewportSize({width:1100,height:760});await review.evaluate(()=>document.fonts.ready);await review.screenshot({path:path.join(artifactDir,'review.png')});
  await review.locator('#reviewed').check();await review.waitForFunction(()=>!document.getElementById('export').disabled);
  await review.locator('#export').click();
  await review.waitForSelector(success?'#result:not([hidden])':'#error:not([hidden])');return review;
 };
 if(suite==='all'||suite==='recording'){
 await open();await waitView('home');assert.equal(await popup.locator('.entry').count(),2);
 assert.match(await popup.locator('body').evaluate(n=>getComputedStyle(n).fontFamily),/Alibaba/);await screenshot('home');passed('home offers the two recording entries in the embedded Alibaba font');
 await popup.evaluate(()=>{
  const send=chrome.runtime.sendMessage.bind(chrome.runtime);
  window.resumeMessages=()=>{chrome.runtime.sendMessage=send;};
  chrome.runtime.sendMessage=message=>message.name==='state'?Promise.resolve({ok:false,error:'读取失败（测试）'}):send(message);
 });
 await popup.locator('.message').filter({hasText:'读取失败（测试）'}).waitFor();await popup.evaluate(()=>window.resumeMessages());
 await popup.locator('.message').filter({hasText:'读取失败（测试）'}).waitFor({state:'hidden'});
 await popup.locator('#entry-manual').click();await waitView('config');assert.equal(await popup.locator('#video').isChecked(),false);
 assert.equal(await popup.locator(`label[title="${originA}/"] input`).isChecked(),true,'the current page is preselected');
 await popup.locator(`label[title="${originB}/"] input`).check();
 await popup.locator('#search').fill('管理后台');assert.equal(await popup.locator('.candidate').count(),1);await popup.locator('#search').fill('');
 await popup.locator('#search').pressSequentially('orders');await popup.keyboard.press('Control+z');
 assert.notEqual(await popup.locator('#search').inputValue(),'orders','native undo must survive filtering');
 await popup.keyboard.press('Control+y');assert.equal(await popup.locator('#search').inputValue(),'orders');
 await popup.locator('#search').fill('');
 const inputSession=await context.newCDPSession(popup);
 await inputSession.send('Input.imeSetComposition',{text:'管',selectionStart:1,selectionEnd:1});
 await inputSession.send('Input.imeSetComposition',{text:'管理',selectionStart:2,selectionEnd:2});
 await inputSession.send('Input.insertText',{text:'管理后台'});
 assert.equal(await popup.locator('#search').inputValue(),'管理后台');assert.equal(await popup.locator('.candidate').count(),1);
 await inputSession.detach();await popup.locator('#search').fill('');
 await screenshot('config');await popup.locator(`label[title="${originB}/"] input`).uncheck();await click('单次录制');await waitView('home');
 assert.equal((await api('state',aid)).session,null);passed('an entry only opens its configuration; nothing records before start');
 await popup.locator('#entry-manual').click();await waitView('config');await click('开始录制');await waitView('recording');await a.click('#action');await popup.waitForFunction(()=>Number(document.querySelector('.metric strong')?.textContent)>0);
 await screenshot('recording');await open();await waitView('recording');assert.equal((await api('state',aid)).session.active,true);passed('manual recording captures real errors and survives popup reopen');
 await open(bid);await waitView('other');await screenshot('outside');
 const elapsed=await popup.locator('.elapsed').textContent();await popup.waitForFunction(before=>document.querySelector('.elapsed').textContent!==before,elapsed);
 await click('把此页面加入记录');await waitView('recording');assert.equal((await api('state',bid)).session.members.length,2);
 let review=await stopToReview();await waitView('stopped');assert.equal((await api('state',bid)).session.active,false);
 await open(bid);await waitView('stopped');assert.equal(await popup.locator('#open-review').textContent(),'回到检查页');await screenshot('stopped');
 await review.waitForSelector('#content:not([hidden])');await review.locator('#note').fill('订单提交失败，预期跳转到结果页面。');
 await review.waitForFunction(()=>document.getElementById('save-status').textContent==='已保存到本机');
 await exportIn(review);await waitView('home');assert.equal((await api('state',bid)).session,null,'export ends the task');
 const report=await lastDownload();assert.ok(report.filename.startsWith(downloadDir),`unsafe test download path ${report.filename}`);
 const firstZip=unzipSync(await fs.readFile(report.filename));const firstReport=strFromU8(firstZip['问题报告.md']);
 assert.match(firstReport,/订单提交失败/);assert.match(firstReport,/参与记录的标签页/);assert.ok(!Object.keys(firstZip).some(n=>/\.(jpg|png|webm)$/.test(n)));
 assert.equal(await review.locator('#result').isVisible(),true);assert.equal(await review.locator('#export').isDisabled(),true);await review.close();
 passed('join, stop straight to review, and a reviewed export ends the task without unselected media');
 await popup.locator('#entry-continuous').click();await waitView('config');assert.equal(await popup.locator('#video').isDisabled(),false);await popup.locator('#video').uncheck();assert.equal((await api('state',bid)).continuous,null);
 await popup.locator(`label[title="${originA}"] input`).check();await click('开启持续录制');await waitView('continuous');
 let cs=(await api('state',bid)).continuous;assert.equal(cs.origins.length,2);assert.equal(cs.recording.length,2);await a.click('#action');await b.click('#action');
 await screenshot('continuous');await a.click('#action');review=await stopToReview('停止并检查');await waitView('stopped');
 cs=(await api('state',bid)).continuous;assert.equal(cs.active,false);assert.ok(cs.segments>=2);assert.ok(cs.totals.errors>=2);await screenshot('continuous-stopped');
 await exportIn(review);await waitView('home');assert.equal((await api('state',bid)).continuous,null);await review.close();
 passed('multiple sites; stopping keeps the last 30 minutes and its export ends the task');
 }
 if(suite==='all'||suite==='retry'){
 await open(bid);await waitView('home');
 // Exercise a real export operation with a deliberate download transport failure.
 await popup.locator('#entry-manual').click();await waitView('config');await click('开始录制');await waitView('recording');await b.click('#action');
 const completedZips=async()=>(await worker.evaluate(()=>chrome.downloads.search({state:'complete'}))).length;const zipsBefore=await completedZips();
 await worker.evaluate(()=>{globalThis.originalDownload=chrome.downloads.download;chrome.downloads.download=async()=>{throw new Error('测试下载失败');};});
 let retryReview=await stopToReview();await waitView('stopped');await exportIn(retryReview,false);await waitView('exportError');const failed=(await api('state',bid)).exportTask;assert.equal(failed.status,'failed');
 const snapshotBefore=await worker.evaluate(()=>chrome.storage.local.get('exportSnapshot'));
 await worker.evaluate(()=>{chrome.downloads.download=globalThis.originalDownload;delete globalThis.originalDownload;});
 await click('重试导出');await waitView('home');assert.equal((await api('state',bid)).session,null);
 // The failed attempt never produced a file; the retry produced exactly one ZIP. (lifecycle tests check it reuses the folder.)
 assert.equal(await completedZips(),zipsBefore+1);assert.ok(unzipSync(await fs.readFile((await lastDownload()).filename))['问题报告.md']);assert.ok(snapshotBefore.exportSnapshot);await retryReview.close();
 passed('failed download never claims success; retry uses the same snapshot and directory, then ends the task');
 await popup.locator('#entry-manual').click();await waitView('config');await click('开始录制');await waitView('recording');await b.click('#action');
 const pendingReview=await stopToReview();await pendingReview.waitForSelector('#content:not([hidden])');
 await pendingReview.waitForFunction(()=>document.getElementById('report').textContent.length>0);
 await pendingReview.locator('#reviewed').check();await pendingReview.waitForFunction(()=>!document.getElementById('export').disabled);
 await worker.evaluate(()=>{
  globalThis.originalDownload=chrome.downloads.download;
  chrome.downloads.download=async options=>{await new Promise(resolve=>{globalThis.releaseDownload=resolve;});return globalThis.originalDownload(options);};
 });
 await pendingReview.locator('#export').click();await waitView('exporting');
 await pendingReview.reload();await pendingReview.getByRole('button',{name:'正在打包并保存…'}).waitFor();
 assert.equal(await pendingReview.locator('#note').isDisabled(),true,'reopening an in-progress export must lock its frozen content');
 await pendingReview.evaluate(()=>{
  const send=chrome.runtime.sendMessage.bind(chrome.runtime);
  window.resumeProgress=()=>{chrome.runtime.sendMessage=send;};
  chrome.runtime.sendMessage=message=>message.name==='state'?Promise.reject(new Error('连接中断（测试）')):send(message);
 });
 await pendingReview.locator('#error').filter({hasText:'正在重新连接'}).waitFor();
 assert.equal(await pendingReview.locator('#export').isDisabled(),true);
 await pendingReview.evaluate(()=>scrollTo(0,0));await pendingReview.screenshot({path:path.join(artifactDir,'export-reconnecting.png')});
 await pendingReview.evaluate(()=>window.resumeProgress());
 await pendingReview.locator('#error').waitFor({state:'hidden'});
 await worker.evaluate(()=>{globalThis.releaseDownload();chrome.downloads.download=globalThis.originalDownload;});
 await pendingReview.locator('#result:not([hidden])').waitFor();
 assert.equal(await pendingReview.locator('#error').isVisible(),false,'completion remains visible after the backend removes the draft');
 assert.equal(await pendingReview.evaluate(()=>document.activeElement.id),'result-title');
 await pendingReview.close();await waitView('home');
 passed('reopened pending export locks editing and receives the completed result without polling a deleted draft');
 await popup.locator('#entry-manual').click();await waitView('config');await click('开始录制');await waitView('recording');(await stopToReview()).close();await waitView('stopped');
 await click('放弃这次录制');await waitView('discard');await click('返回，保留录制');await waitView('stopped');assert.ok((await api('state',bid)).session);
 await click('放弃这次录制');await click('放弃');await waitView('home');assert.equal((await api('state',bid)).session,null);passed('discard cancellation preserves data and explicit confirmation clears it');
 }
 if(suite==='all'||suite==='limits'){
 const more=[];for(let i=0;i<3;i++){const p=await context.newPage();await p.goto(`${originA}/extra-${i}`);more.push(p);}
 await open(bid);await waitView('home');await popup.locator('#entry-manual').click();await waitView('config');
 const available=popup.locator('.candidate input:not(:disabled)');
 for(let i=0;i<3;i++)await available.nth(i+1).check();
 assert.equal(await popup.locator('.candidate input:checked').count(),4);
 assert.ok(await popup.locator('.candidate input:not(:checked):disabled').count()>=1);
 await click('开始录制');await waitView('recording');assert.equal((await api('state',bid)).session.members.length,4);
 const allTabs=await worker.evaluate(()=>chrome.tabs.query({}));
 const memberIds=(await api('state',bid)).session.members.map(m=>m.tabId);
 const fifth=allTabs.find(t=>t.url.startsWith(originA)&&!memberIds.includes(t.id));assert.ok(fifth);
 await open(fifth.id);await waitView('other');assert.equal(await popup.getByRole('button',{name:'把此页面加入记录',exact:true}).isDisabled(),true);
 await assert.rejects(api('join',fifth.id),/最多同时记录 4/);
 await click('查看正在录制的页面');await waitView('recording');await api('stop',fifth.id);await waitView('stopped');
 await click('放弃这次录制');await click('放弃');await waitView('home');
 // Simulate a page whose collector is unavailable (for example, opened before install).
 const unreadyId=allTabs.find(t=>t.url===`${originA}/extra-0`).id;
 await worker.evaluate(id=>{globalThis.originalExecuteScript=chrome.scripting.executeScript;chrome.scripting.executeScript=options=>options.target.tabId===id?Promise.resolve([{frameId:0,result:null}]):globalThis.originalExecuteScript(options);},unreadyId);
 const readiness=await api('state',aid,{candidates:true});const needsRefresh=readiness.candidates.find(c=>c.url===`${originA}/extra-0`);
 assert.equal(needsRefresh.available,false);assert.match(needsRefresh.reason,/刷新/);
 await open(aid);await waitView('home');await popup.locator('#entry-manual').click();await waitView('config');
 assert.equal(await popup.locator(`label[title="${originA}/extra-0"] input`).isDisabled(),true);
 await worker.evaluate(()=>{chrome.scripting.executeScript=globalThis.originalExecuteScript;delete globalThis.originalExecuteScript;});
 passed('four-page limit enforced by UI and backend; unready pages require refresh');
 // Candidate preflight: a page with scripts disabled for collection is presented as unavailable.
 const raw=await api('state',aid,{candidates:true});assert.ok(raw.candidates.some(c=>!c.origin&&!c.available));
 assert.equal(errors.length,0,errors.join('\n'));
 const brokenAssets=await popup.locator('img').evaluateAll(async imgs=>{await Promise.all(imgs.map(i=>i.decode().catch(()=>{})));return imgs.filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src);});assert.deepEqual(brokenAssets,[]);passed('no popup runtime errors or broken image assets');

 // Real tab-close events must free a place without requiring the waiting page to reload.
 await api('continuous-on',bid,{origins:[originA,originB]});
 let coverage=(await api('state',bid)).continuous;
 assert.deepEqual(coverage.origins.map(o=>o.count),[3,1]);assert.equal(coverage.waiting.length,1);
 const waiting=coverage.waiting[0].tabId;
 const closing=coverage.recording.find(t=>t.origin===originA && t.tabId!==aid).tabId;
 await worker.evaluate(id=>chrome.tabs.remove(id),closing);
 await popup.waitForFunction(async({extensionId,waiting})=>{
  const r=await chrome.runtime.sendMessage({type:'command',name:'state',tabId:waiting});return r.result?.continuous?.thisTabRecording;
 },{extensionId,waiting});
 assert.equal((await api('state',waiting)).continuous.recording.length,4);
 await api('continuous-off',bid);await api('continuous-close',bid,{discard:true});
 passed('real tab close automatically admits the waiting page and preserves site coverage');
 }

 if(suite==='all'||suite==='review'){
 await open(aid);await waitView('home');await popup.locator('#entry-manual').click();await waitView('config');await click('开始录制');await waitView('recording');
 await a.bringToFront();await a.click('#action');
 await popup.getByRole('button',{name:'停止录制',exact:true}).focus();
 await a.evaluate(()=>console.error('新增错误，焦点不应消失'));
 await popup.waitForFunction(()=>Number(document.querySelector('.metric strong')?.textContent)>=2);
 assert.equal(await popup.evaluate(()=>document.activeElement?.textContent),'停止录制');
 await a.evaluate(()=>{
  console.log('token=PRIVATE_BROWSER_TOKEN; phone=13800138000; email=qa@example.test');
  fetch('/fail',{method:'POST',body:JSON.stringify({token:'PRIVATE_BODY_TOKEN',item:'blue-shirt'})});
  const input=document.createElement('input');input.type='password';input.value='PRIVATE_PASSWORD';document.body.append(input);input.dispatchEvent(new Event('change',{bubbles:true}));
 });
 await popup.locator('#marker-note').fill('提交订单后出错');await popup.locator('#mark-problem').click();
 await popup.locator('.message').filter({hasText:'已标记'}).waitFor();assert.equal((await api('state',aid)).markers.length,1);
 await screenshot('marked');const review=await stopToReview();await waitView('stopped');
 review.on('pageerror',e=>errors.push(e.message));await review.setViewportSize({width:1280,height:900});
 await review.waitForFunction(()=>document.getElementById('report')?.textContent.length>0);
 await review.locator('#note').fill('测试客户甲提交订单后失败');await review.locator('#expected').fill('显示订单编号');
 await review.waitForFunction(()=>document.getElementById('report').textContent.includes('显示订单编号'));
 let text=await review.locator('#report').textContent();
 assert.match(text,/提交订单后出错/);assert.match(text,/问题标记/);
 assert.doesNotMatch(text,/PRIVATE_BROWSER_TOKEN|PRIVATE_BODY_TOKEN|PRIVATE_PASSWORD|13800138000|qa@example.test|blue-shirt/);
 assert.equal(await review.locator('.media-item input:checked').count(),0);
 await review.locator('#include-bodies').check();await review.locator('#redactions').fill('测试客户甲');
 await review.waitForFunction(()=>document.getElementById('report').textContent.includes('blue-shirt')&&!document.getElementById('report').textContent.includes('测试客户甲'));
 text=await review.locator('#report').textContent();assert.doesNotMatch(text,/PRIVATE_BROWSER_TOKEN|PRIVATE_BODY_TOKEN|13800138000|qa@example.test/);
 const secondReview=await context.newPage();await secondReview.goto(review.url());await secondReview.waitForSelector('.media-item img');
 await review.getByRole('button',{name:'查看并遮挡',exact:true}).first().click();
 await review.locator('dialog[open]').waitFor();assert.equal(await review.evaluate(()=>document.activeElement.id),'close-editor');
 await review.keyboard.press('Shift+Tab');assert.equal(await review.evaluate(()=>document.activeElement.id),'save-image');
 await review.keyboard.press('Tab');assert.equal(await review.evaluate(()=>document.activeElement.id),'close-editor');
 await review.keyboard.press('Escape');assert.equal(await review.evaluate(()=>document.activeElement.textContent),'查看并遮挡');
 await review.getByRole('button',{name:'查看并遮挡',exact:true}).first().click();
 const bounds=await review.locator('#editor-canvas').boundingBox();
 const natural=await review.locator('#editor-canvas').evaluate(n=>({width:n.width,height:n.height}));
 assert.ok(Math.abs(bounds.width/bounds.height-natural.width/natural.height)<0.01,'editor must not letterbox pointer coordinates');
 await review.locator('#precise summary').click();
 for(const [key,value] of Object.entries({x:10,y:20,w:25,h:15}))await review.locator(`#rect-${key}`).fill(String(value));
 await review.locator('#mask-rectangle').click();
 await review.mouse.move(bounds.x+bounds.width*0.6,bounds.y+bounds.height*0.1);await review.mouse.down();
 await review.mouse.move(bounds.x+bounds.width*0.8,bounds.y+bounds.height*0.3);await review.mouse.up();
 await review.screenshot({path:path.join(artifactDir,'editor.png')});
 await worker.evaluate(()=>{
  globalThis.originalStorageSet=chrome.storage.local.set;
  chrome.storage.local.set=values=>values.reviewDraft?Promise.reject(new Error('本机存储空间不足（测试）')):globalThis.originalStorageSet(values);
 });
 await review.locator('#save-image').click();await review.locator('#editor-error:not([hidden])').waitFor();
 assert.match(await review.locator('#editor-error').textContent(),/遮挡未保存/);
 assert.equal(await review.locator('dialog').evaluate(n=>n.open),true);
 await worker.evaluate(()=>{
  chrome.storage.local.set=async values=>{if(values.reviewDraft)await new Promise(resolve=>{globalThis.releaseSave=resolve;});return globalThis.originalStorageSet.call(chrome.storage.local,values);};
 });
 await review.locator('#save-image').click();
 assert.equal(await review.locator('#close-editor').isDisabled(),true);
 assert.equal(await review.locator('#mask-rectangle').isDisabled(),true);
 await review.keyboard.press('Escape');assert.equal(await review.locator('dialog').evaluate(n=>n.open),true);
 // A drag during save must not appear in the preview or the exported image.
 await review.mouse.move(bounds.x+bounds.width*.9,bounds.y+bounds.height*.9);await review.mouse.down();
 await review.mouse.move(bounds.x+bounds.width*.99,bounds.y+bounds.height*.99);await review.mouse.up();
 await worker.evaluate(()=>{globalThis.releaseSave();chrome.storage.local.set=globalThis.originalStorageSet;});
 await review.waitForFunction(()=>!document.querySelector('dialog').open);assert.equal(await review.locator('.media-item input:checked').count(),1);
 const savedImage=await review.locator('.media-item img').first().getAttribute('src');
 await secondReview.waitForFunction(source=>document.querySelector('.media-item img').src===source,savedImage);
 assert.equal(await secondReview.locator('.media-item input:checked').count(),1);
 await secondReview.locator('.media-item input:checked').uncheck();
 await review.waitForFunction(()=>document.querySelectorAll('.media-item input:checked').length===0);
 await secondReview.locator('.media-item input').first().check();
 await review.waitForFunction(()=>document.querySelectorAll('.media-item input:checked').length===1);
 await secondReview.close();
 passed('mask save errors stay inside the dialog; pending masks are locked; other review tabs show the actual saved image and selection');
 await worker.evaluate(()=>{
  globalThis.originalStorageSet=chrome.storage.local.set;
  chrome.storage.local.set=values=>values.reviewDraft?Promise.reject(new Error('本机存储空间不足（测试）')):globalThis.originalStorageSet(values);
 });
 await review.locator('#redactions').fill('测试客户甲\n另一位客户');await review.locator('#error:not([hidden])').waitFor();
 await review.waitForFunction(()=>document.getElementById('save-status').textContent.startsWith('保存失败'));
 assert.equal(await review.locator('#reviewed').isDisabled(),true);
 assert.equal(await review.locator('#reviewed').isChecked(),false);
 assert.equal(await review.locator('#export').isDisabled(),true);
 assert.equal(await review.locator('#redactions').inputValue(),'测试客户甲\n另一位客户');
 await review.locator('#return').click();
 assert.ok(review.url().includes('review.html'),'failed saves must not silently discard edits on return');
 assert.equal(await review.locator('#redactions').inputValue(),'测试客户甲\n另一位客户');
 await review.evaluate(()=>scrollTo(0,0));await review.screenshot({path:path.join(artifactDir,'review-save-error.png')});
 await worker.evaluate(()=>{chrome.storage.local.set=globalThis.originalStorageSet;delete globalThis.originalStorageSet;});
 await review.locator('#retry-save').click();await review.waitForFunction(()=>document.getElementById('save-status').textContent==='已保存到本机');
 assert.equal(await review.locator('#redactions').inputValue(),'测试客户甲\n另一位客户');
 await review.locator('#redactions').fill('测试客户甲');await review.waitForFunction(()=>document.getElementById('save-status').textContent==='已保存到本机');
 await review.locator('#reviewed').check();await review.waitForFunction(()=>!document.getElementById('export').disabled);
 await review.evaluate(()=>{
  const send=chrome.runtime.sendMessage.bind(chrome.runtime);
  window.resumePreview=()=>{chrome.runtime.sendMessage=send;};
  chrome.runtime.sendMessage=message=>message.name==='preview-review'?Promise.reject(new Error('预览暂时不可用（测试）')):send(message);
 });
 await review.locator('#expected').fill('显示订单编号并返回订单列表');
 assert.equal(await review.locator('#reviewed').isChecked(),false);assert.equal(await review.locator('#export').isDisabled(),true);
 await review.locator('#retry-preview:not([hidden])').waitFor();
 assert.equal(await review.locator('#reviewed').isDisabled(),true,'saved content cannot be confirmed until its preview succeeds');
 await review.evaluate(()=>window.resumePreview());await review.locator('#retry-preview').click();
 await review.locator('#reviewed').check();await review.waitForFunction(()=>!document.getElementById('export').disabled);
 await review.waitForFunction(()=>document.getElementById('report').textContent.includes('显示订单编号并返回订单列表'));
 const expectedReport=await review.locator('#report').textContent();
 await review.evaluate(()=>scrollTo(0,0));await review.screenshot({path:path.join(artifactDir,'review-desktop.png'),fullPage:true});
 for(const width of [390,320,768,1024,1440]){
  await review.setViewportSize({width,height:844});await review.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await review.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(width===390)await review.screenshot({path:path.join(artifactDir,'review-narrow.png'),fullPage:true});
 }
 await review.setViewportSize({width:1280,height:900});await review.locator('#export').click();await review.locator('#result:not([hidden])').waitFor();
 const zip=unzipSync(await fs.readFile((await lastDownload()).filename));
 assert.equal(strFromU8(zip['问题报告.md']),expectedReport);
 const images=Object.keys(zip).filter(n=>/\.(png|jpg)$/.test(n));assert.equal(images.length,1);assert.match(images[0],/\.png$/);
 const pixels=await review.evaluate(async base64=>{
  const img=new Image();img.src=`data:image/png;base64,${base64}`;await img.decode();
  const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
  return [[.2,.25],[.7,.2],[.95,.95]].map(([x,y])=>[...ctx.getImageData(Math.floor(c.width*x),Math.floor(c.height*y),1,1).data]);
 },Buffer.from(zip[images[0]]).toString('base64'));
 assert.deepEqual(pixels[0],[0,0,0,255]);assert.deepEqual(pixels[1],[0,0,0,255]);assert.notDeepEqual(pixels[2],[0,0,0,255]);
 await review.bringToFront();await review.locator('#copy-ai').click();await review.getByText('说明已复制',{exact:true}).waitFor();
 await review.locator('#result').scrollIntoViewIfNeeded();await review.screenshot({path:path.join(artifactDir,'review-success.png')});
 passed('marker, private text, opt-in bodies, pointer and keyboard masks, reconfirmation, responsive layout and exact reviewed ZIP');

 await open(aid);await waitView('home');assert.equal((await api('state',aid)).session,null);
 assert.equal(await review.locator('#result').isVisible(),true,'the finished review keeps its result');await review.close();
 await popup.locator('#entry-manual').click();await waitView('config');await click('开始录制');await waitView('recording');await a.click('#action');
 const restartReview=await stopToReview();await waitView('stopped');await restartReview.waitForSelector('#content:not([hidden])');
 await restartReview.locator('#note').fill('浏览器重启仍保留的问题说明');await restartReview.waitForFunction(()=>document.getElementById('save-status').textContent==='已保存到本机');
 await context.close();
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,deviceScaleFactor:2,channel:browserPath?undefined:"chromium",executablePath:browserPath,
  args:[`--disable-extensions-except=${appDir}`,`--load-extension=${appDir}`,`--allowlisted-extension-id=${extensionId}`],ignoreDefaultArgs:['--disable-extensions'],acceptDownloads:true,downloadsPath:downloadDir});
 worker=await readyWorker();
 const recovered=await context.newPage();await recovered.setViewportSize({width:360,height:600});
 await recovered.goto(`chrome-extension://${extensionId}/popup.html?tab=99999`);
 await recovered.getByText('已找回上次录制',{exact:true}).waitFor();
 const recoveredState=await api('state',99999);assert.equal(recoveredState.session.active,false);assert.equal(recoveredState.session.recovered,true);assert.ok(recoveredState.session.totals.errors>0);
 await recovered.screenshot({path:path.join(artifactDir,'recovered.png'),fullPage:true});
 const restoredPage=context.waitForEvent('page');await recovered.locator('#open-review').click();const restoredReview=await restoredPage;
 await restoredReview.waitForFunction(()=>document.getElementById('report')?.textContent.includes('浏览器重启仍保留的问题说明'));
 await restoredReview.locator('#reviewed').check();await restoredReview.waitForFunction(()=>!document.getElementById('export').disabled);
 await restoredReview.locator('#export').click();await restoredReview.locator('#result:not([hidden])').waitFor();
 passed('closing and reopening a real browser restores the stopped draft and exports it without the original tab');

 // Chromium's test allowlist stands in for the toolbar grant. Recording, local
 // persistence, playback and ZIP bytes still use the real tabCapture/MediaRecorder APIs.
 await api('close',99999);
 const otherPage=await context.newPage();await otherPage.goto(originB);const rollPage=await context.newPage();await rollPage.goto(originA);await rollPage.bringToFront();
 const rollTab=(await worker.evaluate(()=>chrome.tabs.query({active:true,lastFocusedWindow:true})))[0].id;
 const otherTab=(await worker.evaluate(()=>chrome.tabs.query({}))).find(t=>t.url.startsWith(originB)).id;
 assert.deepEqual((await api('continuous-on',rollTab,{origins:[originA,originB],video:true})).problems,[]);
 await api('video-authorize',otherTab);
 let cs=(await api('state',otherTab)).continuous;
 assert.ok(cs.recording.some(r=>r.tabId===otherTab),'auto-joined tab records events');
 assert.equal(cs.videoTab?.tabId,rollTab,'only the tab the popup was opened on records video');
 await rollPage.click('#action');await rollPage.waitForTimeout(2200);
 await worker.evaluate(()=>chrome.runtime.sendMessage({target:'offscreen',type:'roll-cut'}));await rollPage.waitForTimeout(2200);
 await api('continuous-off',rollTab);assert.equal((await api('state',rollTab)).continuous.videoTab,null);
 const rollReviewEvent=context.waitForEvent('page');await api('prepare-review',rollTab,{mode:'continuous'});const rollReview=await rollReviewEvent;
 await rollReview.waitForFunction(()=>document.querySelectorAll('.media-item video').length===2&&[...document.querySelectorAll('.media-item video')].every(v=>v.videoWidth>0));
 for(const box of await rollReview.locator('.media-item:has(video) input').all())await box.check();
 await rollReview.locator('#reviewed').check();await rollReview.waitForFunction(()=>!document.getElementById('export').disabled);
 await rollReview.locator('#export').click();await rollReview.locator('#result:not([hidden])').waitFor();
 const rollZip=unzipSync(await fs.readFile((await lastDownload()).filename));
 const clipNames=Object.keys(rollZip).filter(n=>n.endsWith('.webm'));assert.equal(clipNames.length,2);
 for(const n of clipNames)assert.deepEqual([...rollZip[n].slice(0,4)],[0x1a,0x45,0xdf,0xa3]);
 assert.equal((await api('state',rollTab)).continuous,null,'export ends the continuous task');
 passed('continuous video records only the authorized tab as rolling clips that each export as playable files');
 const videoPage=await context.newPage();await videoPage.goto(originA);await videoPage.bringToFront();
 const videoTab=(await worker.evaluate(()=>chrome.tabs.query({active:true,lastFocusedWindow:true})))[0].id;
 assert.deepEqual((await api('start',videoTab,{video:true})).problems,[]);
 assert.equal((await api('state',videoTab)).session.members[0].video,'recording');
 await videoPage.click('#action');await videoPage.waitForTimeout(2200);await api('stop',videoTab);
 assert.ok((await api('state',videoTab)).session.members[0].videoSize>1000);
 await context.close();
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,deviceScaleFactor:2,channel:browserPath?undefined:"chromium",executablePath:browserPath,
  args:[`--disable-extensions-except=${appDir}`,`--load-extension=${appDir}`],ignoreDefaultArgs:['--disable-extensions'],acceptDownloads:true,downloadsPath:downloadDir});
 worker=await readyWorker();
 assert.equal((await api('state',99999)).session.members[0].video,'done');
 const videoReviewEvent=context.waitForEvent('page');await api('prepare-review',99999,{mode:'manual'});const videoReview=await videoReviewEvent;
 await videoReview.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 assert.equal(await videoReview.locator('.media-item:has(video) input').isChecked(),false);
 await videoReview.locator('.media-item:has(video) input').check();
 await videoReview.locator('#reviewed').check();await videoReview.waitForFunction(()=>!document.getElementById('export').disabled);
 await videoReview.locator('#export').click();await videoReview.locator('#result:not([hidden])').waitFor();
 assert.equal((await api('state',99999)).session,null,'export ends the task');
 const videoZip=unzipSync(await fs.readFile((await lastDownload()).filename));assert.equal(Object.keys(videoZip).filter(n=>n.endsWith('.webm')).length,1);const videoName=Object.keys(videoZip).find(n=>n.endsWith('.webm'));
 assert.ok(videoName);assert.deepEqual([...videoZip[videoName].slice(0,4)],[0x1a,0x45,0xdf,0xa3]);
 passed('real tab video remains playable and exports after browser restart; unselected video stays out');
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(temp,'result.json'),JSON.stringify({checks,extensionId,downloadDir,errors},null,2));
 console.log('ARTIFACTS',artifactDir);
}catch(e){console.error(e);if(context){for(const page of context.pages())if(page.url().includes('popup.html')||page.url().includes('review.html'))await page.screenshot({path:path.join(artifactDir,`failure-${page.url().includes('review.html')?'review':'popup'}.png`),fullPage:true}).catch(()=>{});}console.log('ARTIFACTS',artifactDir);process.exitCode=1;}
finally{await context?.close();for(const s of servers)await new Promise(r=>s.close(r));if(process.env.ARTIFACT_DIR)await fs.rm(temp,{recursive:true,force:true});}
