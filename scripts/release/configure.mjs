import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {projectInfo} from './project.mjs';
import {versionParts} from './lib.mjs';

// Local project setup only. Never creates cloud permissions or submits a release.
const [publisherId,itemId,baselineRef,...extra]=process.argv.slice(2);
assert.ok(!extra.length && publisherId && itemId && baselineRef,
  '用法：node scripts/release/configure.mjs PUBLISHER_ID ITEM_ID LAST_SUBMITTED_COMMIT');
assert.match(publisherId,/^[a-zA-Z0-9-]+$/,'发布者 ID 格式错误');
assert.match(itemId,/^[a-p]{32}$/,'扩展 ID 应为 32 位 a-p 字母');
assert.match(baselineRef,/^[a-f0-9]{40}$/,'请提供上次提交商店的完整 Git commit SHA');
projectInfo();
const pkg=JSON.parse(await readFile('package.json','utf8'));
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
versionParts(manifest.version);
assert.equal(pkg.version,manifest.version,'package 与 manifest 版本不一致');
assert.equal(lock.version,pkg.version,'package-lock 版本不一致');
assert.equal(manifest.manifest_version,3,'模板面向 Manifest V3');
for(const command of ['test','test:browser','package:store','release:screenshots']) {
  assert.ok(pkg.scripts?.[command],`请先配置项目自己的 npm run ${command}；详见 RELEASING.md`);
}
assert.match(pkg.devDependencies?.playwright || pkg.dependencies?.playwright || '',/^\d+\.\d+\.\d+$/,'请在 package.json 与 lockfile 中固定 Playwright 版本');
const shared={
  'test:release':'node --test tests/release.test.mjs',
  'release:prepare':'node scripts/release/prepare.mjs',
};
for(const [key,value] of Object.entries(shared)) {
  assert.ok(!pkg.scripts[key] || pkg.scripts[key]===value,`已有 ${key} 命令，请先合并，避免覆盖`);
}
for(const file of ['.release/store.json','.release/baseline.json']) {
  await access(file).then(()=>{throw new Error(`${file} 已存在，未覆盖`);},error=>{if(error.code!=='ENOENT')throw error;});
}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
git('merge-base','--is-ancestor',baselineRef,'HEAD');
const baseline=JSON.parse(git('show',`${baselineRef}:manifest.json`));
versionParts(baseline.version);
await mkdir('.release',{recursive:true});
await writeFile('.release/store.json',JSON.stringify({publisherId,itemId},null,2)+'\n',{flag:'wx'});
await writeFile('.release/baseline.json',JSON.stringify({version:baseline.version,sourceRef:baselineRef,manifest:baseline},null,2)+'\n',{flag:'wx'});
await writeFile('package.json',JSON.stringify({...pkg,scripts:{...pkg.scripts,...shared}},null,2)+'\n');
console.log('项目文件已配置。下一步：设置该仓库的 Google 身份绑定和 chrome-web-store 环境，再运行只读连接检查。');
