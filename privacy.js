// Shared by the page collector and extension modules. No data leaves the browser.
(() => {
  if (globalThis.__epicRecapPrivacy) return;
  const MASK = '******';
  const SENSITIVE = /authorization|cookie|token|secret|passw|pwd|api[-_]?key|session|credential|csrf|xsrf|phone|mobile|email|identity[-_]?card|身份证|手机号|电话号码|邮箱|密码|密钥/i;
  function maskText(value) {
    return String(value ?? '')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, `$1 ${MASK}`)
      .replace(/((?:authorization|cookie|token|secret|password|passwd|pwd|api[-_]?key|session|credential|csrf|xsrf|手机号|电话号码|邮箱|密码|密钥)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;<>"'\r\n]+)/gi, `$1${MASK}`)
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, MASK)
      .replace(/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g, MASK)
      .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, MASK);
  }
  function redactValue(value, depth = 0, seen = new WeakSet()) {
    if (typeof value === 'string') return maskText(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth > 12) return '[嵌套内容已省略]';
    if (seen.has(value)) return '[循环引用]';
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map(v => redactValue(v, depth + 1, seen))
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? MASK : redactValue(v, depth + 1, seen)]));
    seen.delete(value);
    return result;
  }
  function redactText(text) {
    if (!text) return text;
    try { return JSON.stringify(redactValue(JSON.parse(text))); } catch {}
    if (/^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(text)) {
      return text.split('&').map(p => {
        const i = p.indexOf('='), key = p.slice(0, i);
        try { if (SENSITIVE.test(decodeURIComponent(key))) return `${key}=${MASK}`; } catch {}
        return maskText(p);
      }).join('&');
    }
    return maskText(text);
  }
  function redactUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (url.username) url.username = MASK;
      if (url.password) url.password = MASK;
      for (const key of [...url.searchParams.keys()]) {
        url.searchParams.set(key, SENSITIVE.test(key) ? MASK : maskText(url.searchParams.get(key)));
      }
      url.hash = maskText(url.hash);
      return url.href;
    } catch { return maskText(value); }
  }
  Object.defineProperty(globalThis, '__epicRecapPrivacy', {
    value: Object.freeze({ MASK, SENSITIVE, maskText, redactText, redactValue, redactUrl }),
  });
})();
