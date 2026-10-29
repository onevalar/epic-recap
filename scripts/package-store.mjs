import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from '../vendor/fflate.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version, 'Package and manifest versions must match');
assert.ok(manifest.description.length <= 132, 'Chrome description exceeds 132 characters');
assert.ok(!manifest.key && !manifest.update_url, 'Remove development key/update_url before store packaging');

// Explicit runtime allowlist: never ship reports, tests, .git, credentials or release drafts.
const files = [
  'manifest.json', 'bridge.js', 'capture.js', 'export.js', 'hook.js',
  'offscreen.html', 'offscreen.js', 'popup.css', 'popup.html', 'popup.js',
  'privacy.js', 'report.js', 'review.css', 'review.html', 'review.js',
  'sw.js', 'video.js', 'vendor/fflate.js', 'vendor/fflate.LICENSE',
];
for (const [directory, extension] of [['assets', /\.(png|svg)$/], ['icons', /\.png$/], ['fonts', /\.woff2$/]]) {
  for (const name of (await readdir(new URL(`${directory}/`, root))).sort()) {
    if (extension.test(name)) files.push(`${directory}/${name}`);
  }
}
const entries = Object.create(null);
for (const name of files.sort()) {
  assert.ok((await lstat(new URL(name, root))).isFile(), `Not a regular file: ${name}`);
  const data = new Uint8Array(await readFile(new URL(name, root)));
  entries[name] = [data, { mtime: new Date('2020-01-01T00:00:00Z') }];
}
for (const name of [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(script => script.js)]) {
  assert.ok(entries[name], `Manifest references a missing file: ${name}`);
}
const archive = zipSync(entries, { level: 9 });
const extracted = unzipSync(archive);
assert.deepEqual(Object.keys(extracted).sort(), files.sort());
for (const name of files) assert.deepEqual(extracted[name], entries[name][0]);
await mkdir(new URL('dist/', root), { recursive: true });
const name = `epic-recap-${manifest.version}-chrome-web-store.zip`;
await writeFile(new URL(`dist/${name}`, root), archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
await writeFile(new URL(`dist/${name}.sha256`, root), `${sha256}  ${name}\n`);
console.log(JSON.stringify({ file: new URL(`dist/${name}`, root).pathname, files: files.length, bytes: archive.length, sha256 }, null, 2));
