import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
const checks=[];
const passed=name=>{checks.push(name);console.log('PASS',name);};
try{
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,executablePath:browserPath,
   args:[`--disable-extensions-except=${appDir}`,`--load-extension=${appDir}`],ignoreDefaultArgs:['--disable-extensions'],acceptDownloads:true,downloadsPath:downloadDir});
 let worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
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
 const reviewExport=async(success=true)=>{
  const created=context.waitForEvent('page');await click('检查并导出');const review=await created;
  await review.waitForSelector('#content:not([hidden])');await review.waitForFunction(()=>document.getElementById('report').textContent.length>0);
  assert.equal(await review.locator('#export').isDisabled(),true);
  await review.locator('#reviewed').check();await review.waitForFunction(()=>!document.getElementById('export').disabled);
  await review.locator('#export').click();
  await review.waitForSelector(success?'#result:not([hidden])':'#error:not([hidden])');return review;
 };
 await open();await waitView('home');assert.equal(await popup.locator('#video').isChecked(),false);
 assert.match(await popup.locator('body').evaluate(n=>getComputedStyle(n).fontFamily),/Alibaba/);await screenshot('home');passed('home defaults and embedded Alibaba font');
 await popup.locator('#video').uncheck();await click('同时记录多个页面');await waitView('multi');
 await popup.locator(`label[title="${originB}/"] input`).check();
 assert.equal(await popup.locator('#multi-video').isChecked(),false);
 await popup.locator('#search').fill('管理后台');assert.equal(await popup.locator('.candidate').count(),1);await popup.locator('#search').fill('');
 await screenshot('multi');await click('选择页面');await waitView('home');
 assert.equal((await api('state',aid)).session,null);passed('configuration does not start recording and video preference is shared');
 await click('开始记录');await waitView('recording');await a.click('#action');await popup.waitForFunction(()=>Number(document.querySelector('.metric strong')?.textContent)>0);
 await screenshot('recording');await open();await waitView('recording');assert.equal((await api('state',aid)).session.active,true);passed('manual recording captures real errors and survives popup reopen');
 await open(bid);await waitView('other');await screenshot('outside');await click('把此页面加入记录');await waitView('recording');assert.equal((await api('state',bid)).session.members.length,2);
 await click('停止记录');await waitView('stopped');assert.equal((await api('state',bid)).session.active,false);await screenshot('stopped');
 await popup.locator('#note').fill('订单提交失败，预期跳转到结果页面。');await open(bid);assert.equal(await popup.locator('#note').inputValue(),'订单提交失败，预期跳转到结果页面。');
 await reviewExport();await waitView('success');const manual=(await api('state',bid)).exportTask.result;assert.equal(manual.pageCount,2);assert.equal(manual.videoCount,0);
 const saved=await worker.evaluate(()=>chrome.downloads.search({}));const report=saved.find(x=>x.id===manual.reportId);assert.ok(report.filename.startsWith(downloadDir),`unsafe test download path ${report.filename}`);
 const firstZip=unzipSync(await fs.readFile(report.filename));assert.match(strFromU8(firstZip['问题报告.md']),/订单提交失败/);assert.ok(!Object.keys(firstZip).some(n=>/\.(jpg|png|webm)$/.test(n)));await screenshot('success');passed('join, stop, persistent notes and reviewed ZIP export without unselected media');
 await click('开始新的记录');await waitView('home');assert.equal((await api('state',bid)).session,null);
 await popup.locator('#continuous').check();assert.equal(await popup.locator('#video').isDisabled(),true);assert.equal((await api('state',bid)).continuous,null);
 await click('选择多个站点');await waitView('multi');await popup.locator(`label[title="${originA}"] input`).check();await click('开始记录 · 2 个站点');await waitView('continuous');
 let cs=(await api('state',bid)).continuous;assert.equal(cs.origins.length,2);assert.equal(cs.recording.length,2);await a.click('#action');await b.click('#action');
 await screenshot('continuous');await click('导出片段');await waitView('range');await reviewExport();await waitView('success');assert.equal((await api('state',bid)).continuous.active,true);
 await click('返回记录');await waitView('continuous');await a.click('#action');await click('停止持续记录');await waitView('stopped');cs=(await api('state',bid)).continuous;assert.equal(cs.active,false);assert.ok(cs.segments>=2);assert.ok(cs.totals.errors>=2);await screenshot('continuous-stopped');passed('multiple sites, export without stopping, and final segment retained after stop');
 await reviewExport();await waitView('success');await click('开始新的记录');await waitView('home');assert.equal((await api('state',bid)).continuous,null);
 // Exercise a real export operation with a deliberate download transport failure.
 await click('开始记录');await waitView('recording');await b.click('#action');await click('停止记录');await waitView('stopped');
 await worker.evaluate(()=>{globalThis.originalDownload=chrome.downloads.download;chrome.downloads.download=async()=>{throw new Error('测试下载失败');};});
 await reviewExport(false);await waitView('exportError');const failed=(await api('state',bid)).exportTask;assert.equal(failed.status,'failed');
 const snapshotBefore=await worker.evaluate(()=>chrome.storage.local.get('exportSnapshot'));
 await worker.evaluate(()=>{chrome.downloads.download=globalThis.originalDownload;delete globalThis.originalDownload;});
 await click('重试导出');await waitView('success');const retried=(await api('state',bid)).exportTask;assert.equal(retried.id,failed.id);assert.equal(retried.result.folder,`${snapshotBefore.exportSnapshot.folder}.zip`);passed('failed download never claims success; retry uses the same snapshot and directory');
 await click('开始新的记录');await waitView('home');await click('开始记录');await waitView('recording');await click('停止记录');await waitView('stopped');
 await click('放弃这次记录');await waitView('discard');await click('返回，保留记录');await waitView('stopped');assert.ok((await api('state',bid)).session);
 await click('放弃这次记录');await click('放弃并开始新的记录');await waitView('home');assert.equal((await api('state',bid)).session,null);passed('discard cancellation preserves data and explicit confirmation clears it');
 const more=[];for(let i=0;i<3;i++){const p=await context.newPage();await p.goto(`${originA}/extra-${i}`);more.push(p);}
 await open(bid);await waitView('home');await click('同时记录多个页面');await waitView('multi');
 const available=popup.locator('.candidate input:not(:disabled)');
 for(let i=0;i<3;i++)await available.nth(i+1).check();
 assert.equal(await popup.locator('.candidate input:checked').count(),4);
 assert.ok(await popup.locator('.candidate input:not(:checked):disabled').count()>=1);
 await click('开始记录 · 4 个页面');await waitView('recording');assert.equal((await api('state',bid)).session.members.length,4);
 const allTabs=await worker.evaluate(()=>chrome.tabs.query({}));
 const memberIds=(await api('state',bid)).session.members.map(m=>m.tabId);
 const fifth=allTabs.find(t=>t.url.startsWith(originA)&&!memberIds.includes(t.id));assert.ok(fifth);
 await open(fifth.id);await waitView('other');assert.equal(await popup.getByRole('button',{name:'把此页面加入记录',exact:true}).isDisabled(),true);
 await assert.rejects(api('join',fifth.id),/最多同时记录 4/);
 await click('查看正在记录的页面');await waitView('recording');await api('stop',fifth.id);await waitView('stopped');
 await click('放弃这次记录');await click('放弃并开始新的记录');await waitView('home');
 // Simulate a page whose collector is unavailable (for example, opened before install).
 const unreadyId=allTabs.find(t=>t.url===`${originA}/extra-0`).id;
 await worker.evaluate(id=>{globalThis.originalExecuteScript=chrome.scripting.executeScript;chrome.scripting.executeScript=options=>options.target.tabId===id?Promise.resolve([{frameId:0,result:null}]):globalThis.originalExecuteScript(options);},unreadyId);
 const readiness=await api('state',aid,{candidates:true});const needsRefresh=readiness.candidates.find(c=>c.url===`${originA}/extra-0`);
 assert.equal(needsRefresh.available,false);assert.match(needsRefresh.reason,/刷新/);
 await open(aid);await waitView('home');await click('同时记录多个页面');await waitView('multi');
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

 await open(aid);await waitView('home');await click('开始记录');await waitView('recording');
 await a.bringToFront();await a.click('#action');
 await popup.getByRole('button',{name:'停止记录',exact:true}).focus();
 await a.evaluate(()=>console.error('新增错误，焦点不应消失'));
 await popup.waitForFunction(()=>Number(document.querySelector('.metric strong')?.textContent)>=2);
 assert.equal(await popup.evaluate(()=>document.activeElement?.textContent),'停止记录');
 await a.evaluate(()=>{
  console.log('token=PRIVATE_BROWSER_TOKEN; phone=13800138000; email=qa@example.test');
  fetch('/fail',{method:'POST',body:JSON.stringify({token:'PRIVATE_BODY_TOKEN',item:'blue-shirt'})});
  const input=document.createElement('input');input.type='password';input.value='PRIVATE_PASSWORD';document.body.append(input);input.dispatchEvent(new Event('change',{bubbles:true}));
 });
 await popup.locator('#marker-note').fill('提交订单后出错');await popup.locator('#mark-problem').click();
 await popup.locator('.message').filter({hasText:'已标记'}).waitFor();assert.equal((await api('state',aid)).markers.length,1);
 await screenshot('marked');await click('停止记录');await waitView('stopped');
 await popup.locator('#note').fill('测试客户甲提交订单后失败');await popup.locator('#expected').fill('显示订单编号');
 const newReview=context.waitForEvent('page');await click('检查并导出');const review=await newReview;
 review.on('pageerror',e=>errors.push(e.message));await review.setViewportSize({width:1280,height:900});
 await review.waitForFunction(()=>document.getElementById('report')?.textContent.length>0);
 let text=await review.locator('#report').textContent();
 assert.match(text,/提交订单后出错/);assert.match(text,/问题标记/);
 assert.doesNotMatch(text,/PRIVATE_BROWSER_TOKEN|PRIVATE_BODY_TOKEN|PRIVATE_PASSWORD|13800138000|qa@example.test|blue-shirt/);
 assert.equal(await review.locator('.media-item input:checked').count(),0);
 await review.locator('#include-bodies').check();await review.locator('#redactions').fill('测试客户甲');
 await review.waitForFunction(()=>document.getElementById('report').textContent.includes('blue-shirt')&&!document.getElementById('report').textContent.includes('测试客户甲'));
 text=await review.locator('#report').textContent();assert.doesNotMatch(text,/PRIVATE_BROWSER_TOKEN|PRIVATE_BODY_TOKEN|13800138000|qa@example.test/);
 await review.getByRole('button',{name:'查看并遮挡',exact:true}).first().click();
 await review.locator('dialog[open]').waitFor();assert.equal(await review.evaluate(()=>document.activeElement.id),'close-editor');
 await review.keyboard.press('Shift+Tab');assert.equal(await review.evaluate(()=>document.activeElement.id),'save-image');
 await review.keyboard.press('Tab');assert.equal(await review.evaluate(()=>document.activeElement.id),'close-editor');
 await review.keyboard.press('Escape');assert.equal(await review.evaluate(()=>document.activeElement.textContent),'查看并遮挡');
 await review.getByRole('button',{name:'查看并遮挡',exact:true}).first().click();
 const bounds=await review.locator('#editor-canvas').boundingBox();
 const natural=await review.locator('#editor-canvas').evaluate(n=>({width:n.width,height:n.height}));
 assert.ok(Math.abs(bounds.width/bounds.height-natural.width/natural.height)<0.01,'editor must not letterbox pointer coordinates');
 for(const [key,value] of Object.entries({x:10,y:20,w:25,h:15}))await review.locator(`#rect-${key}`).fill(String(value));
 await review.locator('#mask-rectangle').click();
 await review.mouse.move(bounds.x+bounds.width*0.6,bounds.y+bounds.height*0.1);await review.mouse.down();
 await review.mouse.move(bounds.x+bounds.width*0.8,bounds.y+bounds.height*0.3);await review.mouse.up();
 await review.screenshot({path:path.join(artifactDir,'editor.png')});await review.locator('#save-image').click();
 await review.waitForFunction(()=>!document.querySelector('dialog').open);assert.equal(await review.locator('.media-item input:checked').count(),1);
 await worker.evaluate(()=>{
  globalThis.originalStorageSet=chrome.storage.local.set;
  chrome.storage.local.set=values=>values.reviewDraft?Promise.reject(new Error('本机存储空间不足（测试）')):globalThis.originalStorageSet(values);
 });
 await review.locator('#redactions').fill('测试客户甲\n另一位客户');await review.locator('#error:not([hidden])').waitFor();
 await worker.evaluate(()=>{chrome.storage.local.set=globalThis.originalStorageSet;delete globalThis.originalStorageSet;});
 await review.locator('#reviewed').click();await review.waitForFunction(()=>!document.getElementById('reviewed').checked);
 assert.equal(await review.locator('#export').isDisabled(),true);
 assert.equal(await review.locator('#redactions').inputValue(),'测试客户甲\n另一位客户');
 await review.evaluate(()=>scrollTo(0,0));await review.screenshot({path:path.join(artifactDir,'review-save-error.png')});
 await review.locator('#redactions').fill('测试客户甲');await review.waitForFunction(()=>document.getElementById('save-status').textContent==='已保存到本机');
 await review.locator('#reviewed').check();await review.waitForFunction(()=>!document.getElementById('export').disabled);
 await review.locator('#expected').fill('显示订单编号并返回订单列表');
 assert.equal(await review.locator('#reviewed').isChecked(),false);assert.equal(await review.locator('#export').isDisabled(),true);
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
 const exported=(await api('state',aid)).exportTask.result;
 const item=await worker.evaluate(id=>chrome.downloads.search({id}),exported.reportId);
 const zip=unzipSync(await fs.readFile(item[0].filename));
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

 await open(aid);await waitView('success');await click('开始新的记录');await waitView('home');
 await review.locator('#content').waitFor({state:'hidden'});assert.match(await review.locator('#error').textContent(),/草稿已关闭/);
 await click('开始记录');await waitView('recording');await a.click('#action');await click('停止记录');await waitView('stopped');
 await popup.locator('#note').fill('浏览器重启仍保留的问题说明');
 await context.close();
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,executablePath:browserPath,
  args:[`--disable-extensions-except=${appDir}`,`--load-extension=${appDir}`,`--allowlisted-extension-id=${extensionId}`],ignoreDefaultArgs:['--disable-extensions'],acceptDownloads:true,downloadsPath:downloadDir});
 worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const recovered=await context.newPage();await recovered.setViewportSize({width:360,height:600});
 await recovered.goto(`chrome-extension://${extensionId}/popup.html?tab=99999`);
 await recovered.getByText('已找回上次记录',{exact:true}).waitFor();
 assert.equal(await recovered.locator('#note').inputValue(),'浏览器重启仍保留的问题说明');
 const recoveredState=await api('state',99999);assert.equal(recoveredState.session.active,false);assert.equal(recoveredState.session.recovered,true);assert.ok(recoveredState.session.totals.errors>0);
 await recovered.screenshot({path:path.join(artifactDir,'recovered.png'),fullPage:true});
 const restoredPage=context.waitForEvent('page');await recovered.getByRole('button',{name:'检查并导出',exact:true}).click();const restoredReview=await restoredPage;
 await restoredReview.waitForFunction(()=>document.getElementById('report')?.textContent.includes('浏览器重启仍保留的问题说明'));
 await restoredReview.locator('#reviewed').check();await restoredReview.waitForFunction(()=>!document.getElementById('export').disabled);
 await restoredReview.locator('#export').click();await restoredReview.locator('#result:not([hidden])').waitFor();
 passed('closing and reopening a real browser restores the stopped draft and exports it without the original tab');

 // Chromium's test allowlist stands in for the toolbar grant. Recording, local
 // persistence, playback and ZIP bytes still use the real tabCapture/MediaRecorder APIs.
 await api('close',99999);
 const videoPage=await context.newPage();await videoPage.goto(originA);await videoPage.bringToFront();
 const videoTab=(await worker.evaluate(()=>chrome.tabs.query({active:true,lastFocusedWindow:true})))[0].id;
 assert.deepEqual((await api('start',videoTab,{video:true})).problems,[]);
 assert.equal((await api('state',videoTab)).session.members[0].video,'recording');
 await videoPage.click('#action');await videoPage.waitForTimeout(2200);await api('stop',videoTab);
 assert.ok((await api('state',videoTab)).session.members[0].videoSize>1000);
 await context.close();
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,executablePath:browserPath,
  args:[`--disable-extensions-except=${appDir}`,`--load-extension=${appDir}`],ignoreDefaultArgs:['--disable-extensions'],acceptDownloads:true,downloadsPath:downloadDir});
 worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 assert.equal((await api('state',99999)).session.members[0].video,'done');
 const videoReviewEvent=context.waitForEvent('page');await api('prepare-review',99999,{mode:'manual'});const videoReview=await videoReviewEvent;
 await videoReview.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 assert.equal(await videoReview.locator('.media-item:has(video) input').isChecked(),false);
 await videoReview.locator('.media-item:has(video) input').check();
 await videoReview.locator('#reviewed').check();await videoReview.waitForFunction(()=>!document.getElementById('export').disabled);
 await videoReview.locator('#export').click();await videoReview.locator('#result:not([hidden])').waitFor();
 const videoResult=(await api('state',99999)).exportTask.result;assert.equal(videoResult.videoCount,1);
 const videoDownload=await worker.evaluate(id=>chrome.downloads.search({id}),videoResult.reportId);
 const videoZip=unzipSync(await fs.readFile(videoDownload[0].filename));const videoName=Object.keys(videoZip).find(n=>n.endsWith('.webm'));
 assert.ok(videoName);assert.deepEqual([...videoZip[videoName].slice(0,4)],[0x1a,0x45,0xdf,0xa3]);
 passed('real tab video remains playable and exports after browser restart; unselected video stays out');
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(temp,'result.json'),JSON.stringify({checks,extensionId,downloadDir,errors},null,2));
 console.log('ARTIFACTS',artifactDir);
}catch(e){console.error(e);if(context){for(const page of context.pages())if(page.url().includes('popup.html')||page.url().includes('review.html'))await page.screenshot({path:path.join(artifactDir,`failure-${page.url().includes('review.html')?'review':'popup'}.png`),fullPage:true}).catch(()=>{});}console.log('ARTIFACTS',artifactDir);process.exitCode=1;}
finally{await context?.close();for(const s of servers)await new Promise(r=>s.close(r));if(process.env.ARTIFACT_DIR)await fs.rm(temp,{recursive:true,force:true});}
