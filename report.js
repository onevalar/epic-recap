// Turns everything captured into one Markdown report an AI can read directly,
// plus a CSV of every network request the browser made.

const TIMELINE_LIMIT = 400;
const RECENT_OK_REQUESTS = 15;
const PERF_ROWS = 60;

const REQUEST_TYPES = {
  main_frame: '页面', sub_frame: '子页面', xmlhttprequest: '接口', script: '脚本', stylesheet: '样式', image: '图片',
  font: '字体', media: '音视频', websocket: 'WebSocket', ping: '上报', csp_report: '安全策略上报', object: '插件', other: '其他',
};
const typeName = (t) => REQUEST_TYPES[t] || t;

const size = (bytes) => {
  if (bytes == null) return '未知';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  return `${Math.round(bytes / 1048576)} MB`;
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function clock(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function dateTime(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(t)}`;
}

const oneLine = (s, n = 200) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

function fence(text, lang = '') {
  const s = String(text ?? '');
  const longest = Math.max(0, ...(s.match(/`+/g) || []).map((r) => r.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${s}\n${f}`;
}

function bodyBlock(body) {
  try { return fence(JSON.stringify(JSON.parse(body), null, 2), 'json'); } catch { return fence(body); }
}

function shortUrl(u, base) {
  try {
    const x = new URL(u);
    return base && x.origin === new URL(base).origin ? x.pathname + x.search : u;
  } catch { return u; }
}

export const isFailed = (e) => e.type === 'network' && (!e.status || e.status >= 400 || Boolean(e.bizError));
const bizText = (b) => `${b.rule}${b.message ? `「${oneLine(b.message, 120)}」` : ''}`;
const isError = (e) => ['error', 'rejection', 'resource-error'].includes(e.type) || (e.type === 'console' && e.level === 'error');

function actionText(e) {
  switch (e.action) {
    case 'click': return `点击 ${e.target}`;
    case 'change': return `在 ${e.target} ${e.target.startsWith('下拉框') ? '选择' : '填入'}「${e.value}」`;
    case 'check': return `${e.checked ? '勾选' : '取消勾选'} ${e.target}`;
    case 'key': return `在 ${e.target} 按下 ${e.key}`;
    case 'submit': return `提交表单 ${e.target}`;
    default: return `${e.action} ${e.target || ''}`;
  }
}

// Set by buildMarkdown for the export being written: tab labels (only when
// several tabs took part) and each tab's own page URL for shortening addresses.
let ctx = { labels: null, bases: {} };
const tabPrefix = (e) => (ctx.labels && e.tab && ctx.labels[e.tab] ? `[${ctx.labels[e.tab]}] ` : '');

function timelineLine(e, base) {
  if (e.type === 'tab-switch') return `[切换标签页] → ${ctx.labels?.[e.tab] || '另一个标签页'}`;
  return tabPrefix(e) + eventText(e, ctx.bases[e.tab] || base);
}

function eventText(e, base) {
  const frame = e.frame ? `（iframe：${shortUrl(e.frame, base)}）` : '';
  switch (e.type) {
    case 'recording':
      if (e.action === 'start') return e.mode === 'continuous' ? '[片段开始]（持续记录每 5 分钟一段）' : '[开始记录]';
      if (e.reason === 'continuous-off') return '[持续记录已关闭]';
      return `[停止记录] ${e.reason === 'auto' ? '已到时长上限，自动停止' : '手动停止'}`;
    case 'page-load': return `[打开页面] ${e.title ? `「${e.title}」 ` : ''}${e.url}${e.note ? ` —— ${e.note}` : ''}${frame}`;
    case 'navigation': return `[页面跳转] → ${shortUrl(e.to, base)}${frame}`;
    case 'action': return `[操作] ${actionText(e)}${frame}`;
    case 'console': return `[控制台 ${e.level}] ${oneLine(e.message)}${frame}`;
    case 'error': return `[JS 报错] ${oneLine(e.message)}${e.source ? `（${shortUrl(e.source, base)}）` : ''}${frame}`;
    case 'rejection': return `[未处理的 Promise 错误] ${oneLine(e.message)}${frame}`;
    case 'resource-error': return `[资源加载失败] <${e.tag}> ${e.url}${frame}`;
    case 'network': {
      const result = e.status ? `${e.status}${e.statusText ? ` ${e.statusText}` : ''}` : `失败：${e.error || '未知原因'}`;
      if (e.bizError) return `[业务失败] ${e.method} ${shortUrl(e.url, base)} → ${result}，但返回内容表示失败：${bizText(e.bizError)}（${e.duration}ms）${frame}`;
      return `[${isFailed(e) ? '请求失败' : '请求'}] ${e.method} ${shortUrl(e.url, base)} → ${result}（${e.duration}ms）${frame}`;
    }
    case 'browser-request':
      return `[${typeName(e.requestType)}请求失败] ${e.method} ${shortUrl(e.url, base)} → ${e.status || e.error}（${e.duration}ms）`;
    case 'longtask': return `[页面卡顿] 主线程被占用 ${e.duration}ms，期间页面无法响应操作${frame}`;
    default: return `[${e.type}]`;
  }
}

function headerBlock(h) {
  const entries = Object.entries(h || {});
  return entries.length ? fence(entries.map(([k, v]) => `${k}: ${v}`).join('\n')) : '（无）';
}

function requestDetail(e, base, index) {
  const lines = [
    `### ${index}. ${tabPrefix(e)}${e.method} ${shortUrl(e.url, ctx.bases[e.tab] || base)}`,
    '',
    `- 时间：${clock(e.t)}`,
    `- 完整地址：${e.url}`,
    `- 结果：${e.status ? `${e.status} ${e.statusText || ''}` : `失败 —— ${e.error || '未知原因'}`}`,
    ...(e.bizError ? [`- 业务结果：失败（状态码正常，但返回内容表示失败，依据：${bizText(e.bizError)}）`] : []),
    `- 耗时：${e.duration}ms`,
    `- 发起方式：${e.kind}`,
    '',
    '**请求头**',
    '',
    headerBlock(e.requestHeaders),
    '',
  ];
  if (e.requestBody) lines.push('**请求内容**', '', bodyBlock(e.requestBody), '');
  if (e.responseHeaders && Object.keys(e.responseHeaders).length) lines.push('**响应头**', '', headerBlock(e.responseHeaders), '');
  lines.push('**响应内容**', '', e.responseBody ? bodyBlock(e.responseBody) : '（无或未记录）', '');
  return lines.join('\n');
}

function table(head, rows) {
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

function browserRequestsSection(net, base, csvFile) {
  const out = ['## 浏览器层面的全部请求', ''];
  if (!net.length) return [...out, '（无）', ''];
  out.push(`浏览器为${ctx.labels ? '这些标签页' : '这个页面'}一共发出 ${net.length} 个请求，包括接口、页面、脚本、样式、图片等。${csvFile ? `完整清单见同一文件夹下的 ${csvFile}。` : ''}`, '');

  const byType = new Map();
  for (const r of net) {
    const s = byType.get(r.type) || { count: 0, failed: 0, total: 0 };
    s.count++; s.total += r.duration; if (r.failed) s.failed++;
    byType.set(r.type, s);
  }
  out.push(table(['类型', '数量', '失败', '平均耗时'],
    [...byType].sort((a, b) => b[1].count - a[1].count).map(([t, s]) => [typeName(t), s.count, s.failed, `${Math.round(s.total / s.count)}ms`])), '');

  const failed = net.filter((r) => r.failed);
  out.push('### 失败的请求（浏览器视角）', '');
  if (!failed.length) out.push('（无）', '');
  failed.forEach((r, i) => {
    out.push(
      `${i + 1}. ${clock(r.t)} ${tabPrefix(r)}[${typeName(r.type)}] ${r.method} ${r.url} → ${r.status || r.error}（${r.duration}ms${r.inFrame ? '，来自子页面' : ''}）`,
      '',
      '   **请求头**', '', headerBlock(r.requestHeaders).replace(/^/gm, '   '), '',
    );
    if (r.status) out.push('   **响应头**', '', headerBlock(r.responseHeaders).replace(/^/gm, '   '), '');
  });

  const slowest = [...net].sort((a, b) => b.duration - a.duration).slice(0, 10);
  out.push('### 最慢的 10 个请求', '', table(['开始时间', ...(ctx.labels ? ['标签页'] : []), '类型', '地址', '结果', '耗时'],
    slowest.map((r) => [clock(r.t), ...(ctx.labels ? [ctx.labels[r.tab] || ''] : []), typeName(r.type), shortUrl(r.url, ctx.bases[r.tab] || base), r.status || r.error, `${r.duration}ms`])), '');
  return out;
}

function performanceSection(meta, device, perf, events) {
  const out = ['## 设备与性能', ''];
  const d = { ...meta.device, ...device };
  out.push(table(['项目', '内容'], [
    ['CPU', d.cpuModel ? `${d.cpuModel}（${d.cpuCores} 核，${d.arch}）` : `${d.cores ?? '未知'} 核`],
    ['内存总量', d.memTotal ? size(d.memTotal) : d.memoryGB ? `约 ${d.memoryGB} GB` : '未知'],
    ['页面 JS 内存上限', d.heapLimit ? size(d.heapLimit) : '未知'],
    ['网络', d.network || '未知'],
  ]), '');

  if (perf.length) {
    const cpu = perf.filter((p) => p.cpuPercent != null);
    const peakCpu = cpu.reduce((m, p) => (p.cpuPercent > (m?.cpuPercent ?? -1) ? p : m), null);
    const heap = perf.filter((p) => p.heapUsed != null);
    const peakHeap = heap.reduce((m, p) => (p.heapUsed > (m?.heapUsed ?? -1) ? p : m), null);
    const lowMem = perf.reduce((m, p) => (p.memAvailable < (m?.memAvailable ?? Infinity) ? p : m), null);
    out.push(`每 5 秒采样一次。CPU 和可用内存是整台电脑的情况，JS 内存是${ctx.labels ? '对应标签页' : '这个页面'}自己占用的。`, '');
    if (peakCpu) out.push(`- 整机 CPU 最高 ${peakCpu.cpuPercent}%（${clock(peakCpu.t)}）`);
    if (lowMem) out.push(`- 可用内存最低 ${size(lowMem.memAvailable)}（${clock(lowMem.t)}）`);
    if (peakHeap) out.push(`- 页面 JS 内存最高 ${size(peakHeap.heapUsed)}（${clock(peakHeap.t)}${ctx.labels ? `，${ctx.labels[peakHeap.tab] || ''}` : ''}）`);
    const step = Math.ceil(perf.length / PERF_ROWS);
    out.push('', table(['时间', ...(ctx.labels ? ['标签页'] : []), '整机 CPU', '可用内存', '页面 JS 内存'],
      perf.filter((_, i) => i % step === 0).map((p) => [clock(p.t), ...(ctx.labels ? [ctx.labels[p.tab] || ''] : []), p.cpuPercent == null ? '—' : `${p.cpuPercent}%`, size(p.memAvailable), p.heapUsed == null ? '—' : size(p.heapUsed)])), '');
  }

  const longTasks = events.filter((e) => e.type === 'longtask').sort((a, b) => b.duration - a.duration);
  out.push('### 页面卡顿', '');
  if (!longTasks.length) out.push('（没有出现 200ms 以上的卡顿）', '');
  else out.push(`主线程被占用 200ms 以上共 ${longTasks.length} 次，最长的几次：`, '', ...longTasks.slice(0, 10).map((e) => `- ${clock(e.t)} ${tabPrefix(e)}卡住 ${e.duration}ms`), '');
  return out;
}

export function buildNetworkCsv(net, tabs = []) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const labels = Object.fromEntries(tabs.map((t) => [t.key, t.label]));
  const rows = net.map((r) => [clock(r.t), labels[r.tab] || '', typeName(r.type), r.method, r.url, r.status ?? '', r.error ?? '', r.duration, r.fromCache ? '是' : '', r.inFrame ? '是' : '', r.initiator ?? ''].map(q).join(','));
  // The BOM makes Excel read the Chinese headers correctly.
  return `﻿${['开始时间', '标签页', '类型', '方法', '地址', '状态码', '错误', '耗时(ms)', '来自缓存', '来自子页面', '发起方'].map(q).join(',')}\n${rows.join('\n')}`;
}

export function buildMarkdown(data, { note = '', files = {} } = {}) {
  const { meta, tabs = [], net = [], perf = [], device = null, shots = [], videos = [] } = data;
  const base = meta.url;
  const multi = tabs.length > 1;
  ctx = {
    labels: multi ? Object.fromEntries(tabs.map((t) => [t.key, t.label])) : null,
    bases: Object.fromEntries(tabs.map((t) => [t.key, t.url])),
  };
  // Failed non-API requests (images, scripts, pages…) also belong on the timeline.
  const events = [...data.events, ...net
    .filter((r) => r.failed && r.type !== 'xmlhttprequest')
    .map((r) => ({ ...r, type: 'browser-request', requestType: r.type }))].sort((a, b) => a.t - b.t);
  const shotFile = Object.fromEntries(shots.map((s) => [s.id, s.file]));
  const failed = events.filter(isFailed);
  const errors = events.filter(isError);
  const actions = events.filter((e) => e.type === 'action');
  const requests = events.filter((e) => e.type === 'network');
  const okRequests = requests.filter((e) => !isFailed(e)).slice(-RECENT_OK_REQUESTS);
  const longTasks = events.filter((e) => e.type === 'longtask');
  const { startedAt, stoppedAt, stopReason } = meta.recording;
  const end = stoppedAt || meta.exportedAt;
  const seconds = Math.max(1, Math.round((end - startedAt) / 1000));
  const length = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const hhmm = (t) => clock(t).slice(0, 8);
  const period = meta.recording.mode === 'continuous'
    ? `持续记录，导出${meta.recording.rangeMinutes ? `最近 ${meta.recording.rangeMinutes} 分钟` : '全部已保存的记录'}（${hhmm(startedAt)} 至 ${hhmm(end)}，共 ${length}）`
    : `${clock(startedAt)} 至 ${clock(end)}，共 ${length}（${!stoppedAt ? '导出时仍在记录' : stopReason === 'auto' ? `到 ${meta.maxMinutes} 分钟上限自动停止` : '手动停止'}）`;

  const out = [];
  out.push(
    '# 问题现场报告',
    '',
    '> 这份文件由「Epic Recap」浏览器插件自动生成，记录了用户在页面上的操作、页面和浏览器发出的网络请求、控制台日志、报错、设备性能，',
    '> 并在关键时刻自动截图（见同一文件夹下的截图文件，时间线中用 📷 标出）。',
    '> 请结合「问题描述」「时间线」和截图分析问题原因。密码、token、cookie 等敏感字段已替换为 ******。',
    '',
    '## 问题描述',
    '',
    note.trim() || '（用户未填写）',
    '',
    '## 基本信息',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    ...(multi
      ? [`| 参与记录的标签页 | ${tabs.map((t) => `[${t.label}] ${t.url}`).join('；')} |`]
      : [`| 页面地址 | ${meta.url} |`, `| 页面标题 | ${meta.title || '（无）'} |`]),
    `| 导出时间 | ${dateTime(meta.exportedAt)}（${meta.timeZone}） |`,
    `| 记录时段 | ${period} |`,
    `| 浏览器 | ${meta.userAgent} |`,
    `| 窗口 / 屏幕 | ${meta.viewport} / ${meta.screen} |`,
    `| 语言 | ${meta.language} |`,
  );
  const fileList = [
    files.report,
    shots.length && `${shots[0].file} 至 ${shots[shots.length - 1].file}（关键时刻截图 ${shots.length} 张）`,
    files.finalShot && `${files.finalShot}（导出那一刻的画面）`,
    files.networkCsv && `${files.networkCsv}（全部请求清单）`,
    ...videos.map((v) => `${v.file}（${multi ? `${ctx.labels[v.tab]} 的` : ''}视频）`),
  ].filter(Boolean);
  out.push(`| 同一文件夹下的文件 | ${fileList.join('；')} |`);

  out.push('', '## 业务信息', '');
  const metadataBlock = (m) => (m ? fence(JSON.stringify(m, null, 2), 'json') : '（Epic 页面没有提供业务信息）');
  if (multi) for (const t of tabs) out.push(`### ${t.label}`, '', metadataBlock(t.metadata), '');
  else out.push(metadataBlock(tabs[0]?.metadata ?? meta.metadata), '');

  const browserFailed = net.filter((r) => r.failed).length;
  out.push(
    '## 概况',
    '',
    ...(multi ? [`- 标签页：${tabs.length} 个（${tabs.map((t) => t.label).join('、')}），切换 ${events.filter((e) => e.type === 'tab-switch').length} 次`] : []),
    `- 用户操作：${actions.length} 次`,
    `- 页面接口请求：${requests.length} 个，其中失败 ${failed.length} 个${failed.some((e) => e.bizError) ? `（含业务失败 ${failed.filter((e) => e.bizError).length} 个：状态码正常，但返回内容表示失败）` : ''}`,
    `- 浏览器层面全部请求：${net.length} 个（含页面、脚本、样式、图片等），其中失败 ${browserFailed} 个`,
    `- 报错：${errors.length} 条`,
    `- 页面卡顿（主线程占用 200ms 以上）：${longTasks.length} 次${longTasks.length ? `，最长 ${Math.max(...longTasks.map((e) => e.duration))}ms` : ''}`,
    `- 关键时刻截图：${shots.length} 张${videos.length ? `；视频 ${videos.length} 个` : ''}`,
    '',
  );

  const timeline = events.slice(-TIMELINE_LIMIT);
  out.push('## 时间线', '');
  if (events.length > timeline.length) out.push(`（共 ${events.length} 条，只列出最近 ${timeline.length} 条）`, '');
  if (meta.dropped) out.push(`（记录量超过上限，丢弃了 ${meta.dropped} 条较早的普通日志或成功请求；报错、失败请求和操作优先保留）`, '');
  out.push(fence(timeline.map((e) => `${clock(e.t)}  ${timelineLine(e, base)}${shotFile[e.shot] ? `  📷 ${shotFile[e.shot]}` : ''}`).join('\n')), '');

  out.push('## 报错详情', '');
  if (!errors.length) out.push('（无）', '');
  errors.forEach((e, i) => {
    out.push(`### ${i + 1}. ${clock(e.t)} ${timelineLine(e, base)}`, '');
    const body = e.type === 'console' ? e.message : [e.message, e.source && `位置：${e.source}`, e.stack].filter(Boolean).join('\n');
    out.push(fence(body), '');
  });

  out.push('## 失败的请求', '');
  if (!failed.length) out.push('（无）', '');
  failed.forEach((e, i) => out.push(requestDetail(e, base, i + 1)));

  out.push('## 最近成功的请求', '', `（最近 ${okRequests.length} 个，用于判断接口返回的数据是否符合预期）`, '');
  okRequests.forEach((e, i) => out.push(requestDetail(e, base, i + 1)));

  out.push(...browserRequestsSection(net, base, files.networkCsv));
  out.push(...performanceSection(meta, device, perf, events));

  out.push('## 截图', '');
  if (!shots.length && !files.finalShot) out.push('（无）', '');
  for (const s of shots) {
    const moment = events.find((e) => e.shot === s.id);
    out.push(`- ${s.file}（${clock(s.t)}${multi ? `，${ctx.labels[s.tab] || ''}` : ''}）：${moment ? `${timelineLine(moment, base)} 之后` : '关键时刻'}${s.problem ? ' —— 出问题的瞬间' : ''}`);
  }
  if (files.finalShot) out.push(`- ${files.finalShot}（${clock(meta.exportedAt)}）：导出那一刻的画面`);
  for (const v of videos) {
    const secs = Math.round((v.duration || 0) / 1000);
    out.push(`- ${v.file}：${multi ? `${ctx.labels[v.tab]}，` : ''}从 ${clock(v.startedAt)} 开始，时长 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒，${(v.size / 1048576).toFixed(1)} MB`);
  }
  out.push('');

  return out.join('\n');
}
