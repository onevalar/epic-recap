import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
await mkdir(new URL('vendor/', root), { recursive: true });
for (const [source, target] of [['esm/browser.js', 'fflate.js'], ['LICENSE', 'fflate.LICENSE']]) {
  await copyFile(fileURLToPath(new URL(`node_modules/fflate/${source}`, root)), fileURLToPath(new URL(`vendor/${target}`, root)));
}
