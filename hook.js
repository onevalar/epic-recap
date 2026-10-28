// Runs inside the page itself (MAIN world) before the app's own code, so it can
// wrap console / fetch / XHR and watch user actions. The hooks stay passive until
// the extension calls start(); recording then stops on stop() or after
// MAX_DURATION. Events live in memory (bounded by count and size) and are handed
// to the next page via sessionStorage only while navigating, so they survive reloads.
(() => {
  if (window.__epicTS) return;

  const MAX_DURATION = 10 * 60 * 1000;
  // Epic runs locally, so the limits are generous; they still keep one page bounded.
  const MAX_EVENTS = 10000;
  const MAX_BYTES = 10 * 1024 * 1024;
  const BODY_LIMIT = 50000;
  // The report only shows the latest successful responses, so older ones drop their body.
  const KEEP_OK_BODIES = 30;
  // Same-origin iframes share sessionStorage with the top page, so each frame needs its own key.
  const STORE_KEY = window === top ? '__epicTS' : `__epicTS:${location.pathname}`;
  // The recording flag, by contrast, is shared by every same-origin frame in the tab.
  const REC_KEY = '__epicTS:rec';
  const MASK = '******';
  const SENSITIVE = /authorization|cookie|token|secret|passw|pwd|api[-_]?key|session|credential|csrf|xsrf/i;

  const now = () => Date.now();
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…（已截断，原长 ${s.length} 字符）` : s);

  const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  const consoleHooks = new Map(); // level -> { original, wrapper } while wrapped

  let events = [];
  let totalBytes = 0;
  const sizes = new WeakMap();
  const okBodies = [];

  // Rough in-memory size (JS strings are UTF-16).
  function track(e) {
    const size = JSON.stringify(e).length * 2;
    totalBytes += size - (sizes.get(e) || 0);
    sizes.set(e, size);
  }

  const isRoutine = (e) => (e.type === 'console' && (e.level === 'log' || e.level === 'info' || e.level === 'debug'))
    || (e.type === 'network' && e.status > 0 && e.status < 400 && !e.bizError);

  let dropped = 0;
  function removeAt(i) {
    dropped++;
    const [old] = events.splice(i, 1);
    totalBytes -= sizes.get(old) || 0;
    sizes.delete(old);
  }

  // Over budget: drop routine noise (plain logs, successful requests) before evidence.
  function prune() {
    while (events.length > MAX_EVENTS || totalBytes > MAX_BYTES) {
      const i = events.findIndex(isRoutine);
      removeAt(i === -1 ? 0 : i);
    }
  }

  function keepBody(e) {
    if (!e || !e.responseBody || !e.status || e.status >= 400 || e.bizError) return;
    okBodies.push(e);
    while (okBodies.length > KEEP_OK_BODIES) {
      const old = okBodies.shift();
      old.responseBody = '[较早的成功请求，未保留返回内容]';
      if (sizes.has(old)) track(old);
    }
  }

  // ---------- recording state ----------

  // { startedAt, mode: 'manual' | 'continuous', stoppedAt?, stopReason? }; null until the first start().
  // A manual recording ends after MAX_DURATION; a continuous one runs until the
  // extension cuts it into segments or turns it off.
  let rec = null;
  let autoStopTimer;
  const isContinuous = () => rec?.mode === 'continuous';

  function readRec() {
    try { return JSON.parse(sessionStorage.getItem(REC_KEY)); } catch { return null; }
  }
  function writeRec() {
    try { sessionStorage.setItem(REC_KEY, JSON.stringify(rec)); } catch {}
  }

  function isRecording() {
    if (!rec || rec.stoppedAt) return false;
    if (!isContinuous() && now() >= rec.startedAt + MAX_DURATION) { stop('auto'); return false; }
    return true;
  }

  function scheduleAutoStop() {
    clearTimeout(autoStopTimer);
    if (isRecording() && !isContinuous()) autoStopTimer = setTimeout(() => isRecording(), rec.startedAt + MAX_DURATION - now() + 50);
  }

  function stop(reason) {
    if (!rec || rec.stoppedAt) return;
    const stoppedAt = isContinuous() ? now() : Math.min(now(), rec.startedAt + MAX_DURATION);
    if (window === top) record('recording', { action: 'stop', mode: rec.mode, reason, t: stoppedAt });
    rec = { ...rec, stoppedAt, stopReason: reason };
    writeRec();
    clearTimeout(autoStopTimer);
    unwrapConsole();
  }

  // Ids let the extension merge copies of the same event (see the pagehide hand-off below).
  const newId = () => now().toString(36) + Math.random().toString(36).slice(2, 8);

  function record(type, data) {
    const entry = { id: newId(), t: now(), type, page: location.href, ...data };
    events.push(entry);
    track(entry);
    prune();
    return entry;
  }

  // Only records while a recording is running; returns null otherwise.
  const push = (type, data) => (isRecording() ? record(type, data) : null);

  // ---------- signals to the extension (screenshots, performance ticks) ----------

  // Picked up by bridge.js, which runs in the extension's isolated world.
  const signal = (type, payload) => {
    document.dispatchEvent(new CustomEvent('__epicTS:signal', { detail: JSON.stringify({ type, ...payload }) }));
  };

  let lastShotAt = 0;
  let lastProblemShotAt = 0;
  // Ask for a screenshot `delay` ms after `entry`, so it shows the outcome of that moment.
  function requestShot(entry, delay, problem = false) {
    if (!entry) return;
    const t = now();
    if (problem ? t - lastProblemShotAt < 2000 : t - lastShotAt < 1000) return;
    lastShotAt = t;
    if (problem) lastProblemShotAt = t;
    const id = t.toString(36) + Math.random().toString(36).slice(2, 6);
    entry.shot = id;
    track(entry);
    setTimeout(() => { if (isRecording()) signal('shot', { id, problem }); }, delay);
  }

  function deviceInfo() {
    const c = navigator.connection;
    return {
      cores: navigator.hardwareConcurrency,
      memoryGB: navigator.deviceMemory,
      network: c ? `${c.effectiveType || '未知'}，往返约 ${c.rtt}ms，下行约 ${c.downlink}Mbps` : '',
    };
  }

  // Every 5 s while recording, the top frame reports its JS memory; the extension
  // samples system CPU / memory at the same moment.
  let tickTimer;
  function tick() {
    clearTimeout(tickTimer);
    if (window !== top || !isRecording()) return;
    const m = performance.memory;
    signal('tick', { heapUsed: m?.usedJSHeapSize, heapLimit: m?.jsHeapSizeLimit, device: deviceInfo() });
    tickTimer = setTimeout(tick, 5000);
  }

  // Business context the Epic app can expose: window.epicRecap = { metadata: () => ({...}) }
  function readMetadata() {
    try {
      const source = window.epicRecap?.metadata;
      const value = typeof source === 'function' ? source() : source;
      if (!value || typeof value !== 'object') return null;
      const text = JSON.stringify(redactDeep(value));
      return text.length > 20000 ? { 错误: `业务信息超过 20KB（${text.length} 字符），已忽略` } : JSON.parse(text);
    } catch (err) {
      return { 错误: `读取业务信息失败：${err?.message || err}` };
    }
  }

  rec = readRec();
  scheduleAutoStop();
  setTimeout(tick, 1000);

  // Pick up what the previous page in this tab handed over, and remove it from
  // sessionStorage right away so it never sits on the app's own storage quota.
  try {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved) {
      sessionStorage.removeItem(STORE_KEY);
      for (const e of JSON.parse(saved)) { events.push(e); track(e); keepBody(e); }
      prune();
    }
  } catch {}

  addEventListener('pagehide', () => {
    // The tab may be closing or leaving the site, so also hand the events to the
    // extension, which keeps them until the recording is exported or discarded.
    if (rec && events.length) {
      signal('flush', { events, isTop: window === top, url: redactUrl(location.href), title: document.title });
    }
    let list = events;
    while (list.length) {
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(list)); return; } catch {}
      list = list.slice(Math.ceil(list.length / 2)); // over quota: hand over the newer half
    }
  });
  // Back/forward cache restored this page with its memory intact: the hand-over copy isn't needed.
  addEventListener('pageshow', (e) => {
    if (e.persisted) try { sessionStorage.removeItem(STORE_KEY); } catch {}
  });

  // ---------- value formatting & masking ----------

  function redactDeep(value, depth = 0) {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? MASK : redactDeep(v, depth + 1);
    return out;
  }

  function redactText(text) {
    if (!text) return text;
    try { return JSON.stringify(redactDeep(JSON.parse(text))); } catch {}
    // form-encoded bodies: a=1&token=xxx
    if (/^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(text)) {
      return text.split('&').map((p) => {
        const [k] = p.split('=');
        return SENSITIVE.test(decodeURIComponent(k)) ? `${k}=${MASK}` : p;
      }).join('&');
    }
    return text;
  }

  function redactUrl(u) {
    try {
      const url = new URL(u, location.href);
      for (const k of [...url.searchParams.keys()]) if (SENSITIVE.test(k)) url.searchParams.set(k, MASK);
      return url.href;
    } catch { return String(u); }
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { out[k] = v; });
      else Object.assign(out, h);
    } catch {}
    return out;
  }

  function redactHeaders(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = SENSITIVE.test(k) ? MASK : String(v);
    return out;
  }

  function parseRawHeaders(raw) {
    const out = {};
    (raw || '').trim().split(/[\r\n]+/).forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return out;
  }

  function bodyToText(body) {
    if (body == null) return '';
    if (typeof body === 'string') return clip(redactText(body), BODY_LIMIT);
    if (body instanceof URLSearchParams) return clip(redactText(body.toString()), BODY_LIMIT);
    if (body instanceof FormData) {
      const parts = [];
      body.forEach((v, k) => parts.push(`${k}=${SENSITIVE.test(k) ? MASK : typeof v === 'string' ? v : `[文件 ${v.name}, ${v.size} 字节]`}`));
      return clip(parts.join('&'), BODY_LIMIT);
    }
    if (body instanceof Blob) return `[二进制 ${body.type || '未知类型'}, ${body.size} 字节]`;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[二进制 ${body.byteLength} 字节]`;
    return '[无法读取的请求体]';
  }

  function formatArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (arg instanceof Element) return `<${arg.tagName.toLowerCase()}${arg.id ? `#${arg.id}` : ''}>`;
    try {
      const seen = new WeakSet();
      return JSON.stringify(redactDeep(arg), (k, v) => {
        if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[循环引用]'; seen.add(v); }
        if (typeof v === 'function') return `[函数 ${v.name || '匿名'}]`;
        return v;
      });
    } catch { return String(arg); }
  }

  // ---------- console & errors ----------

  // Console methods are wrapped only while recording. A wrapper sits in the call
  // stack of every log, so Chrome lists the page's own errors under the extension;
  // outside a recording the page's console stays untouched.
  function wrapConsole() {
    for (const level of CONSOLE_LEVELS) {
      if (consoleHooks.has(level)) continue; // still in the chain, maybe under another wrapper
      const original = console[level];
      const wrapper = function (...args) {
        if (isRecording()) {
          try {
            const entry = push('console', { level, message: clip(args.map(formatArg).join(' '), 2000) });
            if (level === 'error') requestShot(entry, 300, true);
          } catch {}
        }
        return original.apply(this, args);
      };
      consoleHooks.set(level, { original, wrapper });
      console[level] = wrapper;
    }
  }

  function unwrapConsole() {
    for (const [level, { original, wrapper }] of consoleHooks) {
      // If something wrapped ours since, removing it would cut that out too; leave it (it passes through).
      if (console[level] !== wrapper) continue;
      console[level] = original;
      consoleHooks.delete(level);
    }
  }

  if (isRecording()) wrapConsole();

  addEventListener('error', (e) => {
    const el = e.target;
    if (el && el !== window && el instanceof Element) {
      push('resource-error', { tag: el.tagName.toLowerCase(), url: redactUrl(el.src || el.href || '') });
      return;
    }
    requestShot(push('error', {
      message: e.message || String(e.error),
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
      stack: e.error?.stack || '',
    }), 300, true);
  }, true);

  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    requestShot(push('rejection', { message: r instanceof Error ? `${r.name}: ${r.message}` : formatArg(r), stack: r?.stack || '' }), 300, true);
  });

  // Main-thread freezes the user would feel as lag. Same-origin iframes share the
  // top page's thread and would report the same freeze, so only the top page listens.
  if (window === top) try {
    new PerformanceObserver((list) => {
      for (const task of list.getEntries()) {
        if (task.duration >= 200) push('longtask', { t: Math.round(performance.timeOrigin + task.startTime), duration: Math.round(task.duration) });
      }
    }).observe({ type: 'longtask' });
  } catch {}

  // ---------- network ----------

  const READABLE = /json|text|xml|javascript|html|graphql|x-www-form-urlencoded/i;

  // Many backends answer business failures ("graph is still running") with HTTP 200
  // and put the failure in the body. Recognise the common shapes of such bodies.
  const OK_CODES = new Set(['0', '00', '000', '0000', '00000', '200', 'ok', 'success', 'succeed', 'true']);
  const CODE_KEYS = ['code', 'errCode', 'errcode', 'errorCode', 'error_code', 'errNo', 'errno', 'retCode', 'ret', 'resultCode', 'statusCode'];
  const MESSAGE_KEYS = ['message', 'msg', 'errMsg', 'errmsg', 'errorMessage', 'error_msg', 'errorMsg', 'detail', 'reason'];

  function bizFailure(text) {
    if (!text || !/^\s*\{/.test(text)) return null;
    let body;
    try { body = JSON.parse(text); } catch { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const message = String(MESSAGE_KEYS.map((k) => body[k]).find((v) => typeof v === 'string' && v)
      || (typeof body.error === 'string' ? body.error : body.error?.message) || '');
    const failure = (rule) => ({ rule, message: clip(message, 300) });
    if (body.success === false || body.succeed === false || body.ok === false) return failure('success=false');
    if (Array.isArray(body.errors) && body.errors.length) {
      return { rule: 'errors', message: clip(String(body.errors[0]?.message ?? JSON.stringify(body.errors[0])), 300) };
    }
    if (body.error && typeof body.error !== 'boolean') return failure('error');
    for (const k of CODE_KEYS) {
      const v = body[k];
      if (v == null || typeof v === 'object' || typeof v === 'boolean') continue;
      return OK_CODES.has(String(v).toLowerCase()) ? null : failure(`${k}=${v}`);
    }
    if (typeof body.status === 'string' && /^(error|fail|failed|failure)$/i.test(body.status)) return failure(`status=${body.status}`);
    return null;
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      if (!isRecording()) return originalFetch.apply(this, arguments);
      const start = now();
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const entry = {
        kind: 'fetch',
        method: String(init?.method || (isRequest ? input.method : 'GET')).toUpperCase(),
        url: redactUrl(rawUrl),
        requestHeaders: redactHeaders(headersToObject(init?.headers || (isRequest ? input.headers : null))),
        requestBody: bodyToText(init?.body),
      };
      const promise = originalFetch.apply(this, arguments);
      promise.then((res) => {
        const e = push('network', {
          ...entry, t: start, status: res.status, statusText: res.statusText,
          duration: now() - start, responseHeaders: redactHeaders(headersToObject(res.headers)),
        });
        if (!e) return;
        if (res.status >= 400) requestShot(e, 300, true);
        const type = res.headers.get('content-type') || '';
        if (READABLE.test(type) && !/event-stream/i.test(type)) {
          res.clone().text().then((text) => {
            if (!sizes.has(e)) return; // already pruned
            e.responseBody = clip(redactText(text), BODY_LIMIT);
            const biz = res.status < 400 && bizFailure(redactText(text));
            if (biz) { e.bizError = biz; requestShot(e, 300, true); }
            track(e);
            keepBody(e);
            prune();
          }).catch(() => {});
        } else if (type) {
          e.responseBody = `[${type}，未记录内容]`;
        }
      }, (err) => {
        requestShot(push('network', { ...entry, t: start, status: 0, error: String(err?.message || err), duration: now() - start }), 300, true);
      });
      return promise;
    };
  }

  const XHR = XMLHttpRequest.prototype;
  const xOpen = XHR.open;
  const xSend = XHR.send;
  const xSetHeader = XHR.setRequestHeader;

  XHR.open = function (method, url) {
    this.__epicTS = { method: String(method).toUpperCase(), url: redactUrl(url), headers: {} };
    return xOpen.apply(this, arguments);
  };
  XHR.setRequestHeader = function (k, v) {
    if (this.__epicTS) this.__epicTS.headers[k] = v;
    return xSetHeader.apply(this, arguments);
  };
  XHR.send = function (body) {
    const info = this.__epicTS;
    if (info && isRecording()) {
      const start = now();
      const requestBody = bodyToText(body);
      this.addEventListener('loadend', () => {
        if (!isRecording()) return;
        let responseBody = '';
        try {
          if (this.responseType === '' || this.responseType === 'text') responseBody = this.responseText;
          else if (this.responseType === 'json') responseBody = JSON.stringify(this.response);
          else responseBody = `[${this.responseType}，未记录内容]`;
        } catch {}
        const entry = push('network', {
          kind: 'xhr', t: start, method: info.method, url: info.url,
          status: this.status, statusText: this.statusText, duration: now() - start,
          error: this.status === 0 ? '请求未完成（网络错误、跨域被拦截或被取消）' : undefined,
          requestHeaders: redactHeaders(info.headers), requestBody,
          responseHeaders: redactHeaders(parseRawHeaders(this.getAllResponseHeaders())),
          responseBody: clip(redactText(responseBody), BODY_LIMIT),
          bizError: this.status > 0 && this.status < 400 ? bizFailure(redactText(responseBody)) || undefined : undefined,
        });
        keepBody(entry);
        if (!this.status || this.status >= 400 || entry?.bizError) requestShot(entry, 300, true);
      });
    }
    return xSend.apply(this, arguments);
  };

  // ---------- user actions & navigation ----------

  const INTERACTIVE = 'button,a,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch],[onclick]';

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function describe(el) {
    if (!(el instanceof Element)) return '页面';
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role');
    let kind = `<${tag}>`;
    if (tag === 'button' || role === 'button' || type === 'button' || type === 'submit') kind = '按钮';
    else if (tag === 'a' || role === 'link') kind = '链接';
    else if (tag === 'select') kind = '下拉框';
    else if (tag === 'textarea') kind = '文本框';
    else if (tag === 'input') kind = type === 'checkbox' ? '复选框' : type === 'radio' ? '单选框' : '输入框';
    else if (role === 'tab') kind = '标签页';
    else if (role === 'menuitem') kind = '菜单项';
    else if (role === 'option') kind = '选项';

    if (tag === 'form') kind = '表单';
    const isField = ['input', 'textarea', 'select', 'form'].includes(tag);
    const label = el.getAttribute('aria-label')
      || (el.labels && el.labels[0] && textOf(el.labels[0]))
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || (!isField && textOf(el))
      || el.getAttribute('name')
      || el.getAttribute('alt')
      || '';
    const id = el.id ? ` #${el.id}` : '';
    return `${kind}${label ? `「${clip(label, 40)}」` : ''}${id}`;
  }

  const targetOf = (e) => (e.composedPath ? e.composedPath()[0] : e.target);

  function fieldValue(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || SENSITIVE.test(el.name || '') || SENSITIVE.test(el.id || '')) return MASK;
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map((o) => o.text).join(', ');
    return clip(String(el.value ?? ''), 200);
  }

  addEventListener('click', (e) => {
    if (!isRecording()) return;
    const raw = targetOf(e);
    const el = raw instanceof Element ? raw.closest(INTERACTIVE) || raw : raw;
    requestShot(push('action', { action: 'click', target: describe(el) }), 600);
  }, true);

  addEventListener('change', (e) => {
    const el = targetOf(e);
    if (!isRecording() || !(el instanceof Element)) return;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') push('action', { action: 'check', target: describe(el), checked: el.checked });
    else push('action', { action: 'change', target: describe(el), value: fieldValue(el) });
  }, true);

  addEventListener('keydown', (e) => {
    if (!['Enter', 'Escape', 'Tab'].includes(e.key) || !isRecording()) return;
    const entry = push('action', { action: 'key', key: e.key, target: describe(targetOf(e)) });
    if (e.key === 'Enter') requestShot(entry, 600);
  }, true);

  addEventListener('submit', (e) => {
    push('action', { action: 'submit', target: describe(targetOf(e)) });
  }, true);

  let lastUrl = location.href;
  function navigated(how) {
    if (location.href === lastUrl) return;
    requestShot(push('navigation', { how, from: redactUrl(lastUrl), to: redactUrl(location.href) }), 800);
    lastUrl = location.href;
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      navigated(method);
      return result;
    };
  }
  addEventListener('popstate', () => navigated('popstate'));
  addEventListener('hashchange', () => navigated('hashchange'));

  const loadEvent = push('page-load', { url: redactUrl(location.href), isTop: window === top });
  if (window === top) requestShot(loadEvent, 1200);
  addEventListener('DOMContentLoaded', () => {
    if (loadEvent && sizes.has(loadEvent)) { loadEvent.title = document.title; track(loadEvent); }
  });

  // ---------- API for the extension ----------

  function state() {
    const recording = isRecording();
    const c = {
      recording, mode: rec?.mode, startedAt: rec?.startedAt, stoppedAt: rec?.stoppedAt, stopReason: rec?.stopReason,
      maxDuration: MAX_DURATION, bytes: totalBytes, events: events.length,
      requests: 0, failedRequests: 0, errors: 0, actions: 0,
    };
    for (const e of events) {
      if (e.type === 'network') { c.requests++; if (!e.status || e.status >= 400 || e.bizError) c.failedRequests++; }
      else if (e.type === 'error' || e.type === 'rejection' || e.type === 'resource-error' || (e.type === 'console' && e.level === 'error')) c.errors++;
      else if (e.type === 'action') c.actions++;
    }
    return c;
  }

  function start(startedAt, mode = 'manual') {
    events = [];
    totalBytes = 0;
    dropped = 0;
    okBodies.length = 0;
    rec = { startedAt, mode };
    writeRec();
    lastShotAt = 0;
    lastProblemShotAt = 0;
    // Stamped now, not at startedAt: a tab that joins a running session started recording when it joined.
    if (window === top) record('recording', { action: 'start', mode });
    const page = record('page-load', { url: redactUrl(location.href), title: document.title, isTop: window === top });
    if (window === top) requestShot(page, 300);
    scheduleAutoStop();
    wrapConsole();
    tick();
    return state();
  }

  // Join a recording the extension already runs for this tab (a new page or
  // segment); a no-op when this page is already part of it.
  function ensure({ startedAt, mode }) {
    if (rec && rec.startedAt === startedAt && !rec.stoppedAt) return state();
    return start(startedAt, mode);
  }

  // bridge.js tells new pages of a continuously recorded site to join in.
  document.addEventListener('__epicTS:control', (e) => {
    try { ensure(JSON.parse(e.detail)); } catch {}
  });

  Object.defineProperty(window, '__epicTS', {
    value: Object.freeze({
      state,
      start,
      ensure,
      stop(reason = 'manual') {
        stop(reason);
        return state();
      },
      snapshot() {
        isRecording(); // settles an overdue auto-stop
        return {
          meta: {
            url: redactUrl(location.href),
            title: document.title,
            isTop: window === top,
            userAgent: navigator.userAgent,
            language: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            viewport: `${innerWidth}×${innerHeight}`,
            screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
            exportedAt: now(),
            recording: rec,
            maxMinutes: MAX_DURATION / 60000,
            dropped,
            device: deviceInfo(),
            metadata: window === top ? readMetadata() : null,
          },
          events: JSON.parse(JSON.stringify(events)),
        };
      },
    }),
  });
})();
