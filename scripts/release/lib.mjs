import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from '../../vendor/fflate.js';

export function versionParts(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '版本号格式必须为 0.3.1');
  const parts = value.split('.').map(Number);
  assert.ok(parts.every(n => n <= 65535) && parts.some(Boolean), '版本号超出 Chrome 支持范围');
  return parts;
}
export function compareVersions(a, b) {
  const av = versionParts(a), bv = versionParts(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return Math.sign(av[i] - bv[i]);
  return 0;
}
export function nextVersion(current, input) {
  const parts = versionParts(current), index = {major:0, minor:1, patch:2}[input];
  const result = index === undefined ? input : parts.map((v,i) => i < index ? v : i === index ? v+1 : 0).join('.');
  versionParts(result);
  assert.ok(compareVersions(result,current)>0, '新版本必须高于当前版本');
  return result;
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function reviewFlags(before, after, files) {
  const flags = [];
  for (const key of ['permissions','optional_permissions','host_permissions','optional_host_permissions','content_scripts','minimum_chrome_version','description']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) flags.push(`manifest.${key} 已变化，请核对商店声明`);
  }
  if (files.some(f => /^(popup|review)\.(js|html|css)$|^store\/(listing|screenshots|screenshot-copy)/.test(f))) flags.push('界面或商店素材已变化，请核对介绍和三张截图');
  if (files.some(f => /^(privacy|capture|hook|bridge|sw|export|video|offscreen)\.js$|^docs\/|^store\/privacy/.test(f))) flags.push('数据处理代码或隐私政策已变化，请核对隐私声明');
  return flags;
}
export function verifyBundle(bytes, metadata) {
  assert.equal(sha256(bytes),metadata.sha256,'发布包校验失败');
  const entries = unzipSync(bytes), manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.equal(manifest.version,metadata.version,'ZIP 版本与预览版本不一致');
  return manifest;
}
export function submissionDecision(status, version) {
  const submitted = status.submittedItemRevisionStatus;
  const revisions = [submitted,status.publishedItemRevisionStatus].filter(Boolean);
  assert.ok(revisions.length && revisions.every(r => r.state && r.distributionChannels?.length && r.distributionChannels.every(c => c.crxVersion)), '商店 API 未返回完整版本状态；请查看后台，未上传或提交。');
  const same = revision => revision?.distributionChannels?.some(c => c.crxVersion === version);
  if (same(status.publishedItemRevisionStatus)) return 'already-published';
  if (submitted && ['PENDING_REVIEW','STAGED'].includes(submitted.state)) {
    if (same(submitted)) return 'already-submitted';
    throw new Error('商店已有其他版本等待审核或发布；本流程不会取消或覆盖它。');
  }
  assert.ok(!status.takenDown && !status.warned, '商店有下架或警告，请先在后台处理');
  for (const revision of [submitted,status.publishedItemRevisionStatus]) {
    for (const channel of revision?.distributionChannels || []) {
      assert.ok(compareVersions(version, channel.crxVersion)>0,'版本号必须高于商店已有版本；拒绝或取消后请准备新版本');
    }
  }
  return 'upload';
}
