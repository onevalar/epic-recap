import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../vendor/fflate.js';
import { nextVersion, versionParts, reviewFlags, sha256, verifyBundle, submissionDecision } from '../scripts/release/lib.mjs';
import { publish } from '../scripts/release/publish.mjs';
const bytes=zipSync({'manifest.json':strToU8(JSON.stringify({version:'0.3.1'}))});
const meta={version:'0.3.1',sha256:sha256(bytes),reviewRequired:false};
const config={publisherId:'publisher',itemId:'item'};
const revision=(state,version)=>({state,distributionChannels:[{crxVersion:version}]});
test('version increments and rejects malformed, equal, older or overflowing inputs',()=>{
  assert.equal(nextVersion('0.3.0','patch'),'0.3.1');
  assert.equal(nextVersion('0.3.5','minor'),'0.4.0');
  assert.equal(nextVersion('0.3.5','major'),'1.0.0');
  assert.equal(nextVersion('0.3.5','1.2.3'),'1.2.3');
  for(const v of ['0.3.0','0.2.9','00.3.1','1.0.0;echo hi','1.2.65536','0.0.0'])assert.throws(()=>nextVersion('0.3.0',v));
  assert.throws(()=>nextVersion('1.0.65535','patch'));
  assert.throws(()=>versionParts('../main'));
});
test('permission, UI and privacy changes need human checking',()=>{
  assert.equal(reviewFlags({permissions:['tabs']},{permissions:['tabs']},['tests/a.js']).length,0);
  assert.equal(reviewFlags({permissions:['tabs']},{permissions:['tabs','history']},['popup.js','privacy.js']).length,3);
});
test('checksum and ZIP manifest bind the prepared version',()=>{
  verifyBundle(bytes,meta);
  assert.throws(()=>verifyBundle(bytes,{...meta,sha256:'bad'}));
  assert.throws(()=>verifyBundle(bytes,{...meta,version:'0.3.2'}));
});
test('never replace another pending or staged revision',()=>{
  for(const state of ['PENDING_REVIEW','STAGED'])assert.throws(()=>submissionDecision({submittedItemRevisionStatus:revision(state,'0.3.0')},'0.3.1'));
  assert.equal(submissionDecision({submittedItemRevisionStatus:revision('PENDING_REVIEW','0.3.1')},'0.3.1'),'already-submitted');
  assert.equal(submissionDecision({publishedItemRevisionStatus:revision('PUBLISHED','0.3.1')},'0.3.1'),'already-published');
  assert.throws(()=>submissionDecision({publishedItemRevisionStatus:revision('PUBLISHED','0.4.0')},'0.3.1'));
});
function api(responses){const calls=[];return {calls,fetcher:async(url,options)=>{calls.push({url,...options});assert.ok(responses.length,'unexpected HTTP call');const data=responses.shift();return {ok:true,status:200,json:async()=>data};}};}
test('uploads ZIP then submits review with warning protection',async()=>{
  const a=api([{}, {uploadState:'SUCCEEDED',crxVersion:'0.3.1'},{state:'PENDING_REVIEW'}]);
  const r=await publish({config,meta,bytes,token:'fake',...a});
  assert.equal(r.result,'submitted');assert.equal(a.calls.length,3);
  assert.equal(a.calls[1].body,bytes);
  assert.deepEqual(JSON.parse(a.calls[2].body),{publishType:'DEFAULT_PUBLISH',skipReview:false,blockOnWarnings:true});
});
test('asynchronous upload waits for success before publishing',async()=>{
  const a=api([{}, {uploadState:'IN_PROGRESS'},{lastAsyncUploadState:'SUCCEEDED'},{state:'PENDING_REVIEW'}]);
  await publish({config,meta,bytes,token:'fake',...a,sleep:async()=>{}});
  assert.equal(a.calls[2].method,'GET');assert.equal(a.calls[3].method,'POST');
});
test('failed or unknown uploads never submit',async()=>{
  for(const state of ['FAILED','NOT_FOUND',undefined]){
    const a=api([{}, {uploadState:state}]);
    await assert.rejects(publish({config,meta,bytes,token:'fake',...a}));assert.equal(a.calls.length,2);
  }
});
test('pending review is read-only and retry is idempotent',async()=>{
  const a=api([{submittedItemRevisionStatus:revision('PENDING_REVIEW','0.3.0')}]);
  await assert.rejects(publish({config,meta,bytes,token:'fake',...a}));assert.equal(a.calls.length,1);
  const b=api([{submittedItemRevisionStatus:revision('PENDING_REVIEW','0.3.1')}]);
  assert.equal((await publish({config,meta,bytes,token:'fake',...b})).result,'already-submitted');assert.equal(b.calls.length,1);
});
test('unreviewed metadata stops before any request',async()=>{
  const a=api([]);await assert.rejects(publish({config,meta:{...meta,reviewRequired:true},bytes,token:'fake',...a}));assert.equal(a.calls.length,0);
});
test('HTTP failures redact token and do not repeat mutations',async()=>{
  await assert.rejects(publish({config,meta,bytes,token:'fake-secret',fetcher:async()=>({ok:false,status:403,json:async()=>({error:{message:'bad fake-secret'}})})}),error=>!error.message.includes('fake-secret'));
});
