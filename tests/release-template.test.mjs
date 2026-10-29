import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {unzipSync,zipSync,strToU8,strFromU8} from '../vendor/fflate.js';
import {verifyBundle} from '../scripts/release/lib.mjs';

const source=fileURLToPath(new URL('../',import.meta.url));
test('template configures a different extension without source identity and prepares its own package',async()=>{
  execFileSync(process.execPath,['scripts/release/export-template.mjs'],{cwd:source});
  const entries=unzipSync(await readFile(join(source,'dist/chrome-extension-release-template.zip')));
  assert.ok(entries['scripts/release/configure.mjs']);
  assert.ok(!entries['.release/store.json'] && !entries['scripts/release/setup-google.sh'] && !entries['scripts/release/screenshots.mjs']);
  for(const bytes of Object.values(entries)) {
    assert.doesNotMatch(strFromU8(bytes),/dfabncmibcpdpidadajnboambhinjnnn|able-math-457002-g0|onevalar|Epic Recap/);
  }
  const target=await mkdtemp(join(tmpdir(),'extension-release-test-'));
  const json=async(path,value)=>writeFile(join(target,path),JSON.stringify(value,null,2)+'\n');
  const git=(...args)=>execFileSync('git',args,{cwd:target,encoding:'utf8'}).trim();
  try {
    const manifest={manifest_version:3,name:'Sample Extension',version:'1.2.3'};
    const pkg={name:'sample-extension',version:'1.2.3',type:'module',scripts:{test:'node tests/unit.mjs','test:browser':'node tests/browser.mjs','package:store':'node scripts/build.mjs','release:screenshots':'node scripts/screenshots.mjs'},devDependencies:{playwright:'1.56.1'}};
    await json('manifest.json',manifest);
    await json('package.json',pkg);
    await json('package-lock.json',{name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':{name:pkg.name,version:pkg.version}}});
    git('init','-b','main');git('config','user.name','Release test');git('config','user.email','release-test@example.invalid');
    git('add','manifest.json','package.json','package-lock.json');git('-c','commit.gpgsign=false','commit','-m','Initial extension');
    const baseline=git('rev-parse','HEAD');
    for(const [path,bytes] of Object.entries(entries)) {await mkdir(dirname(join(target,path)),{recursive:true});await writeFile(join(target,path),bytes);}
    const configure=['scripts/release/configure.mjs','publisher-for-test','a'.repeat(32),baseline];
    await json('package.json',{...pkg,scripts:{...pkg.scripts,'test:browser':undefined}});
    const invalid=spawnSync(process.execPath,configure,{cwd:target,encoding:'utf8'});
    assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/test:browser/);
    await assert.rejects(access(join(target,'.release/store.json')));
    await json('package.json',pkg);
    execFileSync(process.execPath,configure,{cwd:target});
    const store=JSON.parse(await readFile(join(target,'.release/store.json')));
    assert.deepEqual(store,{publisherId:'publisher-for-test',itemId:'a'.repeat(32)});
    assert.equal(JSON.parse(await readFile(join(target,'.release/baseline.json'))).sourceRef,baseline);
    const again=spawnSync(process.execPath,configure,{cwd:target,encoding:'utf8'});
    assert.notEqual(again.status,0);assert.match(again.stderr,/已存在/);
    git('add','.');git('-c','commit.gpgsign=false','commit','-m','Configure releases');
    const env={...process.env,RELEASE_VERSION:'patch',RELEASE_NOTES:'修复页面显示',GITHUB_OUTPUT:join(target,'output.txt')};
    delete env.BASELINE_TAG;delete env.GITHUB_STEP_SUMMARY;
    execFileSync(process.execPath,['scripts/release/prepare.mjs'],{cwd:target,env});
    const nextManifest=JSON.parse(await readFile(join(target,'manifest.json')));
    assert.equal(nextManifest.version,'1.2.4');
    assert.equal(JSON.parse(await readFile(join(target,'package-lock.json'))).packages[''].version,'1.2.4');
    const notes=await readFile(join(target,'dist/release/NOTES.md'),'utf8');
    assert.match(notes,/# Sample Extension 1\.2\.4/);assert.match(notes,/修复页面显示/);
    assert.match(await readFile(join(target,'output.txt'),'utf8'),/slug=sample-extension/);
    const archive=zipSync({'manifest.json':strToU8(JSON.stringify(nextManifest))});
    await writeFile(join(target,'dist/sample-extension-1.2.4-chrome-web-store.zip'),archive);
    execFileSync(process.execPath,['scripts/release/finalize.mjs'],{cwd:target});
    const metadata=JSON.parse(await readFile(join(target,'dist/release/release.json')));
    assert.equal(metadata.file,'sample-extension-1.2.4-chrome-web-store.zip');
    assert.equal(verifyBundle(await readFile(join(target,'dist/release',metadata.file)),metadata).version,'1.2.4');
  } finally {await rm(target,{recursive:true,force:true});}
});
