import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export function projectInfo() {
  const pkg=JSON.parse(readFileSync('package.json','utf8'));
  const manifest=JSON.parse(readFileSync('manifest.json','utf8'));
  assert.match(pkg.name,/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'package.json.name 必须是小写英文、数字和短横线组成的包名');
  assert.ok(typeof manifest.name==='string' && manifest.name.trim() && !/[\r\n]/.test(manifest.name),'manifest.name 必须是单行名称');
  return {slug:pkg.name,title:manifest.name};
}
export function archiveName(version) {
  return `${projectInfo().slug}-${version}-chrome-web-store.zip`;
}
