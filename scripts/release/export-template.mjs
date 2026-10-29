import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {zipSync} from '../../vendor/fflate.js';

// Explicit allowlist: no product UI, store ID, Google identity or private files.
const files=[
  '.github/workflows/prepare-release.yml',
  '.github/workflows/publish-release.yml',
  '.github/workflows/check-store.yml',
  ...['lib','project','prepare','finalize','publish','configure'].map(name=>`scripts/release/${name}.mjs`),
  'tests/release.test.mjs','vendor/fflate.js','vendor/fflate.LICENSE',
];
const entries=Object.create(null);
for(const file of files) entries[file]=[new Uint8Array(await readFile(file)),{mtime:new Date('2020-01-01T00:00:00Z')}];
entries['RELEASING.md']=[new Uint8Array(await readFile('scripts/release/template-guide.md')),{mtime:new Date('2020-01-01T00:00:00Z')}];
await mkdir('dist',{recursive:true});
const output='dist/chrome-extension-release-template.zip';
await writeFile(output,zipSync(entries,{level:9}));
console.log(`已生成 ${output}。模板不包含当前插件的商店 ID 或 Google 授权，请按包内 RELEASING.md 接入。`);
