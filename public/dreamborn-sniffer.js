// =====================================================================
//  Ink :: dreamborn.ink API sniffer
// ---------------------------------------------------------------------
//  Paste this whole file into the DevTools console on https://dreamborn.ink
//  (or any subdomain — works on the SPA). It wraps fetch + XHR + WebSocket
//  and records every API call the page makes.
//
//  Then click around the site (load decks, view a card, browse collection,
//  etc.) and the calls collect in `_ink.calls`.
//
//  Commands:
//    _ink.show()      // table of all calls
//    _ink.curls()     // print one bash curl per call
//    _ink.download()  // download JSON + Markdown + curls file
//    _ink.filter('owned-cards')  // narrow & re-show
//    _ink.clear()
//    _ink.stop()      // restore original fetch/XHR/WebSocket
//
//  Secrets (passwords, idTokens, bearer tokens, full cookies) are redacted
//  in the printed/downloaded output. Originals are still sent through.
// =====================================================================

(() => {
  if (window.__inkSniff) {
    console.log('%c[ink-sniff] already running. Use _ink.show() / _ink.stop()', 'color:#06c');
    return;
  }

  const TARGET_RE = /(?:dreamborn\.ink|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firebaseio\.com|cloudfunctions\.net|firestore\.googleapis\.com)/i;
  const ASSET_RE  = /\.(?:js|mjs|css|png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|map)(?:\?|$)/i;

  const calls = [];
  const origFetch = window.fetch.bind(window);
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  const origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origWS = window.WebSocket;

  const wanted = (url) => {
    if (!url) return false;
    if (ASSET_RE.test(url)) return false;
    return TARGET_RE.test(url);
  };

  // ---------- secret redaction ----------
  const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
  function redact(input, type = 'text') {
    if (!input) return input;
    let s = String(input);
    s = s.replace(JWT_RE, '<jwt>');
    s = s.replace(/("password"|"idToken"|"refreshToken"|"token")\s*:\s*"[^"]*"/gi, '$1:"<redacted>"');
    if (type === 'cookie') {
      // Keep just cookie *names* so it's obvious what the site sets.
      s = s.split(/;\s*/).map((kv) => {
        const i = kv.indexOf('=');
        if (i === -1) return kv;
        return `${kv.slice(0, i)}=<…>`;
      }).join('; ');
    }
    if (type === 'authz') s = '<redacted>';
    return s;
  }

  function hdrsToObj(h) {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h };
  }
  function redactHdrs(h) {
    const o = {};
    for (const [k, v] of Object.entries(h)) {
      const kl = k.toLowerCase();
      if (kl === 'authorization' || /api-key/i.test(kl)) o[k] = redact(v, 'authz');
      else if (kl === 'cookie' || kl === 'set-cookie') o[k] = redact(v, 'cookie');
      else o[k] = String(v);
    }
    return o;
  }

  // ---------- printer ----------
  function logRec(rec) {
    const ok = rec.status >= 200 && rec.status < 300;
    const color = rec.status === 'ERR' ? '#c00' : ok ? '#080' : '#c60';
    const u = (() => { try { const x = new URL(rec.url); return x.pathname + (x.search ? '?…' : ''); } catch { return rec.url; } })();
    console.log(
      `%c[${rec.kind}] %c${rec.method.padEnd(6)} %c${String(rec.status).padEnd(4)} %c${u} %c${Math.round(rec.ms)}ms`,
      'color:#888', 'color:#06c;font-weight:600', `color:${color};font-weight:600`, 'color:#000', 'color:#888'
    );
  }

  // ---------- fetch hook ----------
  window.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input
              : input instanceof URL    ? input.href
              :                            (input.url || String(input));
    if (!wanted(url)) return origFetch(input, init);

    const start = performance.now();
    const method = (init.method
                 || (typeof input === 'object' && input.method)
                 || 'GET').toUpperCase();
    const reqHeaders = hdrsToObj(
      init.headers
      || (typeof input === 'object' && input.headers && Object.fromEntries(input.headers))
      || {}
    );
    let reqBody = init.body ?? (input instanceof Request ? null : null);
    if (reqBody && typeof reqBody !== 'string') {
      try { reqBody = '[non-text body: ' + reqBody.constructor.name + ']'; } catch { reqBody = '[non-text body]'; }
    }

    const rec = {
      t: new Date().toISOString(),
      kind: 'fetch',
      method, url,
      reqHeaders: redactHdrs(reqHeaders),
      reqBody: reqBody ? redact(reqBody) : null,
      status: null, respHeaders: null, respBody: null, ms: 0,
    };

    try {
      const res = await origFetch(input, init);
      rec.status = res.status;
      rec.respHeaders = redactHdrs(Object.fromEntries(res.headers.entries()));
      try {
        const txt = await res.clone().text();
        rec.respBody = redact(txt.length > 32768 ? txt.slice(0, 32768) + '\n…[truncated]' : txt);
      } catch { rec.respBody = '[unreadable body]'; }
      rec.ms = performance.now() - start;
      calls.push(rec);
      logRec(rec);
      return res;
    } catch (err) {
      rec.status = 'ERR';
      rec.respBody = String(err);
      rec.ms = performance.now() - start;
      calls.push(rec);
      logRec(rec);
      throw err;
    }
  };

  // ---------- XHR hook ----------
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__inkRec = { method: String(method).toUpperCase(), url: String(url), reqHeaders: {} };
    return origXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__inkRec) this.__inkRec.reqHeaders[k] = v;
    return origXhrSetHeader.call(this, k, v);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const r = this.__inkRec;
    if (!r || !wanted(r.url)) return origXhrSend.call(this, body);
    const start = performance.now();
    const rec = {
      t: new Date().toISOString(),
      kind: 'xhr',
      method: r.method, url: r.url,
      reqHeaders: redactHdrs(r.reqHeaders),
      reqBody: typeof body === 'string' ? redact(body)
            : body ? '[non-text body]' : null,
      status: null, respHeaders: null, respBody: null, ms: 0,
    };
    this.addEventListener('loadend', () => {
      rec.status = this.status || 'ERR';
      const h = (this.getAllResponseHeaders() || '')
        .split(/\r?\n/).filter(Boolean)
        .map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; });
      rec.respHeaders = redactHdrs(Object.fromEntries(h));
      try {
        const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : '[' + this.responseType + ']';
        rec.respBody = redact((t || '').length > 32768 ? t.slice(0, 32768) + '\n…[truncated]' : t);
      } catch { rec.respBody = '[unreadable]'; }
      rec.ms = performance.now() - start;
      calls.push(rec);
      logRec(rec);
    });
    return origXhrSend.call(this, body);
  };

  // ---------- WebSocket hook (just URL logging) ----------
  function PatchedWS(url, protocols) {
    if (wanted(url)) {
      const rec = { t: new Date().toISOString(), kind: 'ws', method: 'WS', url: String(url), reqHeaders: {}, reqBody: null, status: 'open', respHeaders: null, respBody: null, ms: 0 };
      calls.push(rec); logRec(rec);
    }
    return protocols !== undefined ? new origWS(url, protocols) : new origWS(url);
  }
  PatchedWS.prototype = origWS.prototype;
  PatchedWS.CONNECTING = origWS.CONNECTING;
  PatchedWS.OPEN = origWS.OPEN;
  PatchedWS.CLOSING = origWS.CLOSING;
  PatchedWS.CLOSED = origWS.CLOSED;
  window.WebSocket = PatchedWS;

  // ---------- helpers ----------
  function shortUrl(u) {
    try { const x = new URL(u); return x.origin + x.pathname + (x.search ? '?…' : ''); } catch { return u; }
  }
  function toCurl(r) {
    const out = [`curl '${r.url.replace(/'/g, "'\\''")}'`, `  -X ${r.method}`];
    for (const [k, v] of Object.entries(r.reqHeaders || {})) {
      if (k.toLowerCase() === 'host' || k.toLowerCase() === 'content-length') continue;
      out.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
    }
    if (r.reqBody) {
      out.push(`  --data-raw '${String(r.reqBody).replace(/'/g, "'\\''")}'`);
    }
    return out.join(' \\\n');
  }
  function uniqueEndpoints(arr) {
    const m = new Map();
    for (const r of arr) {
      try {
        const u = new URL(r.url);
        const key = `${r.method} ${u.origin}${u.pathname}`;
        const e = m.get(key) || { line: key, count: 0, statuses: new Set() };
        e.count++; e.statuses.add(r.status);
        m.set(key, e);
      } catch {}
    }
    return [...m.values()]
      .sort((a, b) => a.line.localeCompare(b.line))
      .map((e) => `${e.line.padEnd(70)}  ×${e.count}   ${[...e.statuses].join('/')}`);
  }
  function renderMarkdown(arr) {
    const lines = [];
    lines.push(`# dreamborn.ink API capture — ${new Date().toISOString()}`);
    lines.push(`\n${arr.length} call(s) recorded.\n\n## Endpoint index\n`);
    for (const l of uniqueEndpoints(arr)) lines.push(`- \`${l.trim()}\``);
    lines.push('\n## Details\n');
    for (const r of arr) {
      lines.push(`### ${r.method} ${shortUrl(r.url)} → ${r.status}\n`);
      lines.push(`- time: \`${r.t}\` · kind: \`${r.kind}\` · ${Math.round(r.ms)}ms`);
      lines.push(`- url: \`${r.url}\``);
      if (r.reqBody) {
        lines.push('\nRequest body:');
        lines.push('```\n' + r.reqBody.slice(0, 4096) + '\n```');
      }
      if (r.respBody) {
        lines.push('\nResponse:');
        lines.push('```\n' + r.respBody.slice(0, 4096) + '\n```');
      }
      lines.push('\nReproducing curl:');
      lines.push('```bash\n' + toCurl(r) + '\n```\n');
    }
    return lines.join('\n');
  }
  function download(filename, content, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- public API ----------
  window.__inkSniff = { calls };
  window._ink = {
    get calls() { return calls; },
    show(filterStr) {
      const arr = filterStr ? calls.filter((c) => (c.url + ' ' + (c.reqBody || '')).includes(filterStr)) : calls;
      console.table(arr.map((c, i) => ({
        '#': i,
        kind: c.kind,
        method: c.method,
        status: c.status,
        url: shortUrl(c.url),
        ms: Math.round(c.ms),
      })));
      console.log(`%c${arr.length} call(s). Inspect: _ink.calls[N]`, 'color:#888');
      return arr.length;
    },
    filter(s) { return this.show(s); },
    endpoints() { uniqueEndpoints(calls).forEach((l) => console.log(l)); },
    curls(filterStr) {
      const arr = filterStr ? calls.filter((c) => c.url.includes(filterStr)) : calls;
      arr.forEach((r) => { console.log('# ' + r.method + ' ' + shortUrl(r.url) + '  → ' + r.status); console.log(toCurl(r)); console.log(''); });
      return arr.length;
    },
    detail(i) { console.log(JSON.stringify(calls[i], null, 2)); return calls[i]; },
    download() {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      download(`dreamborn-calls-${ts}.json`, JSON.stringify(calls, null, 2), 'application/json');
      download(`dreamborn-calls-${ts}.md`,   renderMarkdown(calls), 'text/markdown');
      download(`dreamborn-curls-${ts}.sh`,   calls.map((r) => '# ' + r.method + ' ' + shortUrl(r.url) + ' → ' + r.status + '\n' + toCurl(r) + '\n').join('\n'), 'text/x-shellscript');
      console.log(`%c⬇ downloaded ${calls.length} calls (json + md + sh)`, 'color:#080');
    },
    clear() { calls.length = 0; console.log('cleared.'); },
    stop() {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origXhrOpen;
      XMLHttpRequest.prototype.send = origXhrSend;
      XMLHttpRequest.prototype.setRequestHeader = origXhrSetHeader;
      window.WebSocket = origWS;
      delete window.__inkSniff;
      delete window._ink;
      console.log('%c[ink-sniff] stopped. (recorded ' + calls.length + ' calls)', 'color:#06c');
    },
  };

  console.log(
    '%c🟦 Ink dreamborn-sniff active.\n' +
    '   Browse the site to record calls. Then:\n' +
    '     _ink.show()        table\n' +
    '     _ink.endpoints()   unique URL list\n' +
    '     _ink.detail(0)     one full record\n' +
    '     _ink.curls()       paste-ready bash curls\n' +
    '     _ink.download()    json + md + .sh files\n' +
    '     _ink.stop()        unhook',
    'color:#06c; font-family: monospace'
  );
})();
