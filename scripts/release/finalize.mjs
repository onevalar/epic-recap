import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { sha256 } from './lib.mjs';
import { archiveName } from './project.mjs';
const meta = JSON.parse(await readFile('dist/release/prepare.json','utf8'));
const file = archiveName(meta.version);
const zip = await readFile(`dist/${file}`);
await copyFile(`dist/${file}`,`dist/release/${file}`);
await writeFile('dist/release/release.json',JSON.stringify({...meta,file,sha256:sha256(zip)},null,2)+'\n');
