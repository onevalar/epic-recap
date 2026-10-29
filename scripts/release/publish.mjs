import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { versionParts, verifyBundle, submissionDecision } from './lib.mjs';

export async function publish({token, config, meta, bytes, confirmed=false, mode='DEFAULT_PUBLISH', fetcher=fetch, sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  versionParts(meta.version); verifyBundle(bytes,meta);
  assert.ok(!meta.reviewRequired || confirmed,'此版本涉及界面、权限或隐私变化，请先核对预览并完成后台更新，再勾选确认');
  assert.ok(['DEFAULT_PUBLISH','STAGED_PUBLISH'].includes(mode));
  assert.ok(token,'未配置 Google 发布授权');
  const resource = `publishers/${encodeURIComponent(config.publisherId)}/items/${encodeURIComponent(config.itemId)}`;
  const call = async (path, method='GET', body, contentType='application/json') => {
    const response = await fetcher(`https://chromewebstore.googleapis.com/${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':contentType},body,signal:AbortSignal.timeout(120000)});
    const data = await response.json();
    if (!response.ok) throw new Error(`Chrome Web Store 请求失败 (${response.status}): ${String(data.error?.message || '请检查后台').replaceAll(token,'[redacted]')}`);
    return data;
  };
  const before = await call(`v2/${resource}:fetchStatus`);
  const decision = submissionDecision(before,meta.version);
  if (decision !== 'upload') return {result:decision,status:before};
  const upload = await call(`upload/v2/${resource}:upload`,'POST',bytes,'application/zip');
  let state = upload.uploadState;
  for (let i=0; ['IN_PROGRESS','UPLOAD_IN_PROGRESS'].includes(state) && i<30; i++) {
    await sleep(10000);
    state = (await call(`v2/${resource}:fetchStatus`)).lastAsyncUploadState;
  }
  assert.ok(['SUCCEEDED','UPLOAD_SUCCESS'].includes(state),`上传未成功：${state}。未提交审核。`);
  if (upload.crxVersion) assert.equal(upload.crxVersion,meta.version);
  const result = await call(`v2/${resource}:publish`,'POST',JSON.stringify({publishType:mode,skipReview:false,blockOnWarnings:true}));
  assert.ok(['PENDING_REVIEW','STAGED','PUBLISHED','PUBLISHED_TO_TESTERS'].includes(result.state),`商店没有确认提交：${JSON.stringify(result)}`);
  return {result:'submitted',response:result};
}

if (process.argv[1]?.endsWith('/publish.mjs')) {
  const meta = JSON.parse(await readFile('dist/release/release.json','utf8'));
  const expected = process.env.RELEASE_VERSION;
  assert.equal(meta.version,expected,'所选版本与下载的发布包不一致');
  assert.equal(meta.file,`epic-recap-${expected}-chrome-web-store.zip`);
  const result = await publish({token:process.env.CWS_ACCESS_TOKEN,config:JSON.parse(await readFile('.release/store.json','utf8')),meta,bytes:await readFile(`dist/release/${meta.file}`),confirmed:process.env.METADATA_CONFIRMED==='true',mode:process.env.PUBLISH_MODE || 'DEFAULT_PUBLISH'});
  await writeFile('dist/release/submission-result.json',JSON.stringify(result,null,2)+'\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,`\nChrome Web Store ${meta.version}：${result.result}\n\n提交审核不代表已上架，请查看商店状态。\n`);
  console.log(result.result);
}
