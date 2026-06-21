#!/usr/bin/env node
// sniff-api.mjs — attach to a Chrome tab via CDP, log every API call.
//
// Usage:
//   1. Chrome must be running with --remote-debugging-port=9222 (the pi-chrome
//      profile we already use does this).
//   2. node scripts/sniff-api.mjs [--target=dreamborn.ink] [--out=captures]
//   3. Browse the target site. Every fetch/XHR is logged.
//   4. Ctrl-C to stop. We write:
//        captures/calls-<timestamp>.json    full request+response payloads
//        captures/calls-<timestamp>.md      human-readable summary + curls
//        captures/endpoints-<timestamp>.txt one URL per unique endpoint
//
// Optional flags:
//   --target=substr     only log URLs containing this substring (default: dreamborn.ink)
//   --port=9222         CDP port (default 9222)
//   --tab=substr        attach to a tab whose URL or title contains this substring
//                       (default: most recent page tab)
//   --include-assets    don't filter out .js/.css/.png/.jpg/.webp/.woff
//   --include-google    include identitytoolkit / googleapis traffic too
//   --max-body=65536    cap response body bytes captured per request

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      return [k, rest.length ? rest.join('=') : true];
    }
    return [a, true];
  })
);
const TARGETS = (args.target || 'dreamborn.ink').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(args.port) || 9222;
const TAB_HINT = args.tab || '';
const INCLUDE_ASSETS = !!args['include-assets'];
const INCLUDE_GOOGLE = !!args['include-google'];
const MAX_BODY = Number(args['max-body']) || 64 * 1024;
const OUT_DIR = path.resolve(ROOT, args.out || 'captures');

await fs.mkdir(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const JSON_PATH = path.join(OUT_DIR, `calls-${ts}.json`);
const MD_PATH   = path.join(OUT_DIR, `calls-${ts}.md`);
const EP_PATH   = path.join(OUT_DIR, `endpoints-${ts}.txt`);

// ---------- pick a tab ----------
const tabsRes = await fetch(`http://localhost:${PORT}/json`);
if (!tabsRes.ok) {
  console.error(`❌ Chrome CDP not reachable at localhost:${PORT}. Start Chrome with --remote-debugging-port=${PORT}.`);
  process.exit(1);
}
const tabs = (await tabsRes.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!tabs.length) {
  console.error('❌ No page tabs found. Open a tab in Chrome first.');
  process.exit(1);
}

let tab = tabs[0];
if (TAB_HINT) {
  const hit = tabs.find((t) => (t.url + ' ' + t.title).toLowerCase().includes(TAB_HINT.toLowerCase()));
  if (hit) tab = hit;
}

console.log(`🔌 Attaching to tab:`);
console.log(`   ${tab.title}`);
console.log(`   ${tab.url}\n`);
console.log(`🎯 Targets: ${TARGETS.join(', ')}${INCLUDE_GOOGLE ? ' + google auth' : ''}`);
console.log(`📁 Output:  ${OUT_DIR}/`);
console.log(`   Tip: navigate to https://dreamborn.ink and click around. Ctrl-C to stop.\n`);

// ---------- CDP wire ----------
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let _id = 0;
const pending = new Map();
const sessions = new Map();   // sessionId -> { send }
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++_id;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

// ---------- per-request bookkeeping ----------
/** @type {Map<string, any>} */
const reqs = new Map();

const requestPredicate = (url) => {
  if (!url) return false;
  if (!INCLUDE_ASSETS && /\.(?:js|mjs|css|png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|map)(?:\?|$)/i.test(url)) return false;
  for (const t of TARGETS) if (url.includes(t)) return true;
  if (INCLUDE_GOOGLE && /(?:googleapis\.com|identitytoolkit|firebase)/.test(url)) return true;
  return false;
};

ws.addEventListener('open', async () => {
  await send('Page.enable');
  await send('Network.enable', { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 5 * 1024 * 1024 });
  await send('Runtime.runIfWaitingForDebugger').catch(() => {});
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  console.log('✅ CDP attached. Listening for requests…\n');
});

ws.addEventListener('message', (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const { requestId, request, type, initiator, redirectResponse } = msg.params;
    if (redirectResponse) {
      // record the redirect and start a fresh record under the same id
      const prev = reqs.get(requestId);
      if (prev) {
        prev.responses ||= [];
        prev.responses.push({
          status: redirectResponse.status,
          headers: redirectResponse.headers,
          mimeType: redirectResponse.mimeType,
          redirect: true,
          url: redirectResponse.url,
        });
      }
    }
    if (!requestPredicate(request.url)) return;
    reqs.set(requestId, {
      requestId,
      url: request.url,
      method: request.method,
      reqHeaders: request.headers,
      postData: request.postData,
      hasPostData: request.hasPostData,
      type,
      initiator: initiator?.type,
      startedAt: Date.now(),
      response: null,
      bodyText: null,
      bodyB64: false,
      printed: false,
    });
  }
  if (msg.method === 'Network.responseReceived') {
    const r = reqs.get(msg.params.requestId);
    if (!r) return;
    const { response } = msg.params;
    r.response = {
      status: response.status,
      statusText: response.statusText,
      mimeType: response.mimeType,
      headers: response.headers,
      remoteAddr: response.remoteIPAddress,
      protocol: response.protocol,
      url: response.url,
    };
  }
  if (msg.method === 'Network.loadingFinished') {
    const r = reqs.get(msg.params.requestId);
    if (!r) return;
    capture(msg.params.requestId).catch(() => {});
  }
  if (msg.method === 'Network.loadingFailed') {
    const r = reqs.get(msg.params.requestId);
    if (!r) return;
    r.failed = msg.params.errorText || 'failed';
    printOne(r);
  }
});

async function capture(requestId) {
  const r = reqs.get(requestId);
  if (!r) return;
  try {
    const body = await send('Network.getResponseBody', { requestId });
    let text = body.body || '';
    if (body.base64Encoded) {
      r.bodyB64 = true;
      // Keep base64 but cap it
      text = text.slice(0, Math.ceil(MAX_BODY * 4 / 3));
    } else if (text.length > MAX_BODY) {
      text = text.slice(0, MAX_BODY) + `\n…[truncated ${text.length - MAX_BODY} chars]`;
    }
    r.bodyText = text;
  } catch (e) {
    r.bodyText = `[no body: ${e.message}]`;
  }
  printOne(r);
}

function printOne(r) {
  if (r.printed) return;
  r.printed = true;
  const status = r.response?.status ?? (r.failed ? 'FAIL' : '?');
  const mime = r.response?.mimeType || '';
  const len  = r.bodyText ? `${r.bodyB64 ? 'b64 ' : ''}${r.bodyText.length}b` : '';
  console.log(`${pad(r.method, 6)} ${pad(String(status), 4)} ${pad(r.type, 12)} ${shortUrl(r.url)}  ${mime}  ${len}${r.failed ? '  ❌ ' + r.failed : ''}`);
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.origin + url.pathname + (url.search ? '?…' : '');
  } catch { return u; }
}

// ---------- shutdown: write outputs ----------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  // capture bodies for anything still mid-flight
  const ids = [...reqs.keys()];
  for (const id of ids) {
    const r = reqs.get(id);
    if (r.bodyText == null && r.response) {
      try { await capture(id); } catch {}
    }
  }

  const all = [...reqs.values()].filter((r) => r.response || r.failed);
  all.sort((a, b) => a.startedAt - b.startedAt);

  await fs.writeFile(JSON_PATH, JSON.stringify(all, null, 2));
  await fs.writeFile(MD_PATH, renderMarkdown(all));
  await fs.writeFile(EP_PATH, uniqueEndpoints(all).join('\n') + '\n');

  console.log(`\n📦 Wrote ${all.length} request(s):`);
  console.log(`   ${path.relative(ROOT, JSON_PATH)}`);
  console.log(`   ${path.relative(ROOT, MD_PATH)}`);
  console.log(`   ${path.relative(ROOT, EP_PATH)}`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- formatters ----------
function uniqueEndpoints(all) {
  const out = new Map();
  for (const r of all) {
    try {
      const u = new URL(r.url);
      const key = `${r.method} ${u.origin}${u.pathname}`;
      const prev = out.get(key);
      const status = r.response?.status ?? 0;
      if (!prev || (status >= 200 && status < 300 && prev.status >= 400)) {
        out.set(key, { line: key, status });
      }
    } catch { /* ignore */ }
  }
  return [...out.values()].map((e) => `${e.line}  → ${e.status}`).sort();
}

function renderMarkdown(all) {
  const groups = new Map();   // origin+path  ->  [requests]
  for (const r of all) {
    try {
      const u = new URL(r.url);
      const key = `${r.method} ${u.origin}${u.pathname}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    } catch { /* skip */ }
  }

  const sections = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const lines = [];
  lines.push(`# API calls captured ${ts}`);
  lines.push('');
  lines.push(`Total: **${all.length}** request(s) across **${groups.size}** unique endpoint(s).`);
  lines.push('');
  lines.push(`## Endpoint index`);
  lines.push('');
  for (const [key, reqs] of sections) {
    const statuses = [...new Set(reqs.map((r) => r.response?.status ?? 'fail'))].join('/');
    lines.push(`- \`${key}\` × ${reqs.length}  (${statuses})`);
  }
  lines.push('');

  for (const [key, reqs] of sections) {
    lines.push(`---\n`);
    lines.push(`## ${key}`);
    lines.push('');
    const sample = reqs[0];
    const mime = sample.response?.mimeType || '?';
    lines.push(`- count: ${reqs.length}`);
    lines.push(`- mime:  \`${mime}\``);
    lines.push(`- initiator: \`${sample.initiator || '?'}\` · resource type: \`${sample.type}\``);
    lines.push('');
    lines.push('### Example request');
    lines.push('');
    lines.push(`URL: \`${sample.url}\``);
    lines.push('');

    if (sample.reqHeaders && Object.keys(sample.reqHeaders).length) {
      lines.push('Headers (request):');
      lines.push('```');
      for (const [k, v] of Object.entries(sample.reqHeaders)) {
        // mask obvious secrets in headers we capture for display
        if (/cookie|authorization|x-api-key|token/i.test(k)) {
          lines.push(`${k}: <redacted>`);
        } else {
          lines.push(`${k}: ${v}`);
        }
      }
      lines.push('```');
    }

    if (sample.postData) {
      lines.push('Request body:');
      lines.push('```');
      lines.push(redact(sample.postData));
      lines.push('```');
    }

    if (sample.bodyText) {
      lines.push('Example response (truncated to first 4 KB):');
      lines.push('```' + (sample.response?.mimeType?.includes('json') ? 'json' : ''));
      lines.push(sample.bodyText.slice(0, 4096));
      lines.push('```');
    }

    lines.push('');
    lines.push('### curl');
    lines.push('```bash');
    lines.push(toCurl(sample));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function redact(s) {
  if (!s) return s;
  // mask passwords + bearer tokens + idTokens that look like JWTs (3 base64 chunks).
  return String(s)
    .replace(/"password"\s*:\s*"[^"]*"/g, '"password":"<redacted>"')
    .replace(/("token"|"idToken"|"refreshToken")\s*:\s*"[^"]*"/g, '$1:"<redacted>"')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<redacted-jwt>');
}

function toCurl(r) {
  const parts = [`curl '${r.url}' \\`];
  parts.push(`  -X ${r.method} \\`);
  const hdr = r.reqHeaders || {};
  for (const [k, v] of Object.entries(hdr)) {
    if (k.toLowerCase() === 'host' || k.toLowerCase() === 'content-length') continue;
    const safe = /cookie|authorization|x-api-key|token/i.test(k) ? '<redacted>' : String(v).replace(/'/g, "'\\''");
    parts.push(`  -H '${k}: ${safe}' \\`);
  }
  if (r.postData) {
    parts.push(`  --data-raw '${redact(r.postData).replace(/'/g, "'\\''")}'`);
  } else {
    parts[parts.length - 1] = parts[parts.length - 1].replace(/ \\$/, '');
  }
  return parts.join('\n');
}
