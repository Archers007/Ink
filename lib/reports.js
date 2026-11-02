// Issue reports from the /admin page, and the issue board behind it.
//
// A moderator writes up a problem (title, what happened, a screenshot) on /admin. The report is queued here; the
// issue worker running on the maintainer's own machine (tools/issue-worker.mjs) picks it up, files it as a GitHub
// issue with the same text and image, and — when the "fix with Claude" switch is on — opens a terminal there running
// Claude on the issue. The worker posts the issue link and its progress back, so the board shows where each report is.
//
// The board itself lists the repository's open GitHub issues (public API, cached a minute) with Ink's status on the
// ones that came from here.
//
// Routes (moderator+ unless noted):
//   GET  /api/admin/issues                 open GitHub issues + Ink's reports and their status, + the switches
//   POST /api/admin/reports                { title, body, image?: dataURL }  → the queued report
//   POST /api/admin/reports/:id/status     { status, note? }   mark done / failed / queued again by hand
//   GET  /api/admin/settings · POST (admin) { key, value }     switches: issues_on, fix_on
//   GET  /api/worker/queue                 (worker token)  reports waiting, with the switches
//   POST /api/worker/reports/:id           (worker token)  { status, issue_url?, issue_number?, note? }
//   GET  /api/reports/:id/image/:key       the screenshot (public, unguessable key — GitHub shows it inline)
//
// Env: INK_GITHUB_REPO (owner/name), INK_WORKER_TOKEN (shared with the worker), PUBLIC_URL (for the image link).

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = process.env.INK_GITHUB_REPO || 'Archers007/Ink';
const WORKER_TOKEN = process.env.INK_WORKER_TOKEN || '';
const MAX_IMAGE = 6 * 1024 * 1024;
const STATUSES = new Set(['queued', 'creating', 'issue', 'agent', 'pr', 'done', 'failed', 'cancelled']);
const GH_TTL_MS = 3 * 60_000;      // the public API allows 60 requests an hour; a refresh is up to three calls
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function attachReports(app, { db, accounts, dataDir }) {
  if (!db || !accounts?.requireRole) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL,
      context      TEXT,                   -- JSON the page attached (browser, url, …)
      image        TEXT,                   -- file name under data/reports
      image_key    TEXT,                   -- unguessable part of its public URL
      status       TEXT NOT NULL DEFAULT 'queued',
      note         TEXT,
      issue_url    TEXT,
      issue_number INTEGER,
      created      INTEGER NOT NULL,
      updated      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (                -- the board's history: who did what, and how each issue turned out
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      actor        TEXT NOT NULL,                       -- an account's name, 'worker', or 'github'
      kind         TEXT NOT NULL,                       -- filed · issue · agent · pr · done · failed · cancelled · queued · switch
      detail       TEXT,
      report_id    INTEGER,
      issue_number INTEGER,
      url          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
  `);
  const cols = db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name);
  if (!cols.includes('pr_url')) db.exec('ALTER TABLE reports ADD COLUMN pr_url TEXT');
  const imgDir = path.join(dataDir, 'reports');
  fs.mkdirSync(imgDir, { recursive: true });

  const q = {
    insert: db.prepare('INSERT INTO reports (user_id, title, body, context, image, image_key, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT r.*, u.name AS author FROM reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?'),
    recent: db.prepare('SELECT r.*, u.name AS author FROM reports r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created DESC LIMIT 200'),
    queued: db.prepare("SELECT r.*, u.name AS author FROM reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.status = 'queued' ORDER BY r.created ASC LIMIT 5"),
    setStatus: db.prepare('UPDATE reports SET status = ?, note = ?, updated = ? WHERE id = ?'),
    setIssue: db.prepare('UPDATE reports SET status = ?, note = ?, issue_url = ?, issue_number = ?, updated = ? WHERE id = ?'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    setPr: db.prepare('UPDATE reports SET status = ?, pr_url = ?, note = ?, updated = ? WHERE id = ?'),
    tracked: db.prepare("SELECT * FROM reports WHERE issue_number IS NOT NULL AND status NOT IN ('done', 'cancelled')"),
    logAct: db.prepare('INSERT INTO activity (at, actor, kind, detail, report_id, issue_number, url) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    activity: db.prepare('SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT 300'),
  };
  const act = (actor, kind, detail, r = null, url = null) => q.logAct.run(Date.now(), actor, kind, detail || null, r?.id ?? null, r?.issue_number ?? null, url || r?.issue_url || null);
  const DEFAULTS = { issues_on: '1', fix_on: '1' };
  const setting = (k) => q.getSetting.get(k)?.value ?? DEFAULTS[k];
  const switches = () => ({ issues_on: setting('issues_on') === '1', fix_on: setting('fix_on') === '1' });

  const publicUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const out = (r, req) => ({
    id: r.id, title: r.title, body: r.body, context: r.context ? JSON.parse(r.context) : null, author: r.author,
    status: r.status, note: r.note, issueUrl: r.issue_url, issueNumber: r.issue_number, prUrl: r.pr_url, created: r.created, updated: r.updated,
    imageUrl: r.image ? `${publicUrl(req)}/api/reports/${r.id}/image/${r.image_key}` : null,
  });

  // ----- the GitHub side of the board -----
  // open issues, the recently closed ones (so a fixed issue shows as fixed), and the pull requests — which also tell
  // us how each report turned out: a PR that says "Fixes #N" moves it to "PR open", a closed issue to "done".
  const ghHeaders = { accept: 'application/vnd.github+json', 'user-agent': 'ink-admin-board', ...(process.env.INK_GITHUB_TOKEN ? { authorization: `Bearer ${process.env.INK_GITHUB_TOKEN}` } : {}) };
  async function gh(pathAndQuery) {
    const r = await fetch(`https://api.github.com/repos/${REPO}${pathAndQuery}`, { headers: ghHeaders });
    if (!r.ok) throw new Error(`GitHub ${r.status}${r.status === 403 ? ' (rate limit — set INK_GITHUB_TOKEN)' : ''}`);
    return r.json();
  }
  const issueOut = (i) => ({
    number: i.number, title: i.title, url: i.html_url, author: i.user?.login, created: Date.parse(i.created_at), updated: Date.parse(i.updated_at),
    closed: i.closed_at ? Date.parse(i.closed_at) : null, stateReason: i.state_reason || null,
    comments: i.comments, labels: (i.labels || []).map((l) => ({ name: l.name, color: l.color })), body: (i.body || '').slice(0, 2000),
  });
  const mentions = (pr, n) => new RegExp(`(^|[^0-9])#${n}([^0-9]|$)`).test(`${pr.title}\n${pr.body || ''}`);
  let ghCache = { at: 0, issues: [], closed: [], prs: [], error: null };
  async function github() {
    if (Date.now() - ghCache.at < GH_TTL_MS) return ghCache;
    try {
      const [open, closed, prs] = await Promise.all([
        gh('/issues?state=open&per_page=100'),
        gh('/issues?state=closed&per_page=30&sort=updated'),
        gh('/pulls?state=all&per_page=50&sort=updated&direction=desc'),
      ]);
      ghCache = {
        at: Date.now(), error: null,
        issues: open.filter((i) => !i.pull_request).map(issueOut),
        closed: closed.filter((i) => !i.pull_request).map(issueOut),
        prs: prs.map((p) => ({ number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'merged' : p.state, body: (p.body || '').slice(0, 4000), updated: Date.parse(p.updated_at) })),
      };
      reconcile();
    } catch (e) {
      ghCache = { ...ghCache, at: Date.now() - GH_TTL_MS + 20_000, error: e.message };   // try again in 20s, keep the last good lists
    }
    return ghCache;
  }
  // what GitHub says became of each report we filed
  function reconcile() {
    for (const r of q.tracked.all()) {
      const closedIssue = ghCache.closed.find((i) => i.number === r.issue_number);
      if (closedIssue) {
        const fixed = closedIssue.stateReason !== 'not_planned';
        q.setStatus.run('done', fixed ? 'issue closed on GitHub' : 'closed on GitHub as not planned', Date.now(), r.id);
        act('github', 'done', fixed ? `issue #${r.issue_number} was closed — fixed` : `issue #${r.issue_number} was closed as not planned`, r, closedIssue.url);
        continue;
      }
      const pr = ghCache.prs.find((p) => mentions(p, r.issue_number));
      if (pr && r.pr_url !== pr.url) {
        q.setPr.run('pr', pr.url, `${pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed unmerged' : 'open'}: ${pr.title}`.slice(0, 200), Date.now(), r.id);
        act('github', 'pr', `pull request #${pr.number} for issue #${r.issue_number} (${pr.state}): ${pr.title}`.slice(0, 300), r, pr.url);
      }
    }
  }

  const bigJson = express.json({ limit: '9mb' });
  const workerOk = (req, res) => {
    const given = req.get('x-ink-worker') || '';
    if (!WORKER_TOKEN || given.length !== WORKER_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(WORKER_TOKEN))) {
      res.status(WORKER_TOKEN ? 401 : 503).json({ error: WORKER_TOKEN ? 'bad worker token' : 'INK_WORKER_TOKEN is not set on the server' });
      return false;
    }
    return true;
  };

  // ----- board -----
  app.get('/api/admin/issues', async (req, res) => {
    const u = accounts.requireRole(req, res, 'moderator'); if (!u) return;
    const g = await github();
    res.set('Cache-Control', 'no-store');
    res.json({
      repo: REPO, issues: g.issues, closed: g.closed, githubError: g.error, githubAt: g.at,
      prsByIssue: Object.fromEntries([...g.issues, ...g.closed].map((i) => [i.number, g.prs.filter((p) => mentions(p, i.number)).map(({ number, url, state, title }) => ({ number, url, state, title }))]).filter(([, v]) => v.length)),
      reports: q.recent.all().map((r) => out(r, req)), switches: switches(), workerConfigured: !!WORKER_TOKEN,
    });
  });
  app.get('/api/admin/activity', (req, res) => {
    if (!accounts.requireRole(req, res, 'moderator')) return;
    res.set('Cache-Control', 'no-store');
    res.json({ activity: q.activity.all() });
  });

  app.post('/api/admin/reports', bigJson, (req, res) => {
    const u = accounts.requireRole(req, res, 'moderator'); if (!u) return;
    if (!switches().issues_on) return res.status(409).json({ error: 'Reports are switched off in Settings.' });
    const title = String(req.body?.title || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
    const body = String(req.body?.body || '').replace(/\r\n/g, '\n').trim().slice(0, 20_000);
    if (title.length < 4) return res.status(400).json({ error: 'Give it a title (4+ characters).' });
    if (body.length < 10) return res.status(400).json({ error: 'Describe what happened (10+ characters).' });
    let image = null, key = null;
    const data = req.body?.image;
    if (data) {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data));
      if (!m) return res.status(400).json({ error: 'The screenshot must be a PNG, JPEG, GIF or WebP image.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_IMAGE) return res.status(413).json({ error: 'The screenshot is over 6 MB.' });
      key = crypto.randomBytes(12).toString('base64url');
      image = `${Date.now()}-${key}.${IMAGE_TYPES[m[1]]}`;
      fs.writeFileSync(path.join(imgDir, image), buf);
    }
    const ctx = req.body?.context && typeof req.body.context === 'object' ? JSON.stringify(req.body.context).slice(0, 8000) : null;
    const now = Date.now();
    const id = Number(q.insert.run(u.id, title, body, ctx, image, key, 'queued', now, now).lastInsertRowid);
    act(u.name, 'filed', `filed "${title}"`, q.byId.get(id));
    res.json({ report: out(q.byId.get(id), req), workerConfigured: !!WORKER_TOKEN });
  });

  app.post('/api/admin/reports/:id/status', (req, res) => {
    const u = accounts.requireRole(req, res, 'moderator'); if (!u) return;
    const r = q.byId.get(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'No such report.' });
    const status = String(req.body?.status || '');
    if (!['queued', 'done', 'failed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'status must be queued, done, failed or cancelled' });
    const note = String(req.body?.note || '').slice(0, 500) || null;
    q.setStatus.run(status, note, Date.now(), r.id);
    act(u.name, status, `${{ queued: 'queued again', done: 'marked done', failed: 'marked failed', cancelled: 'cancelled' }[status]} "${r.title}"${note ? ` — ${note}` : ''}`, r);
    res.json({ report: out(q.byId.get(r.id), req) });
  });

  app.get('/api/admin/settings', (req, res) => {
    if (!accounts.requireRole(req, res, 'moderator')) return;
    res.json({ switches: switches(), repo: REPO, workerConfigured: !!WORKER_TOKEN });
  });
  app.post('/api/admin/settings', (req, res) => {
    if (!accounts.requireRole(req, res, 'admin')) return;
    const key = String(req.body?.key || '');
    if (!(key in DEFAULTS)) return res.status(400).json({ error: 'unknown setting' });
    q.putSetting.run(key, req.body?.value ? '1' : '0');
    act(accounts.userFromReq(req)?.name || 'admin', 'switch', `turned ${{ issues_on: 'Accept reports', fix_on: 'Fix with Claude' }[key]} ${req.body?.value ? 'on' : 'off'}`);
    res.json({ switches: switches() });
  });

  // ----- the worker on the maintainer's machine -----
  app.get('/api/worker/queue', (req, res) => {
    if (!workerOk(req, res)) return;
    res.set('Cache-Control', 'no-store');
    res.json({ repo: REPO, switches: switches(), reports: q.queued.all().map((r) => out(r, req)) });
  });
  app.post('/api/worker/reports/:id', (req, res) => {
    if (!workerOk(req, res)) return;
    const r = q.byId.get(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'No such report.' });
    const status = String(req.body?.status || '');
    if (!STATUSES.has(status)) return res.status(400).json({ error: 'bad status' });
    const note = String(req.body?.note || '').slice(0, 500) || null;
    if (req.body?.issue_url) q.setIssue.run(status, note, String(req.body.issue_url).slice(0, 300), Number(req.body.issue_number) || null, Date.now(), r.id);
    else q.setStatus.run(status, note, Date.now(), r.id);
    const now = q.byId.get(r.id);
    if (status !== 'creating') act('worker', status, `${{ issue: 'filed the issue for', agent: 'started Claude on', failed: 'failed on' }[status] || status} "${r.title}"${note ? ` — ${note}` : ''}`, now);
    ghCache.at = 0;                                               // the board should show the new issue right away
    res.json({ report: out(now, req) });
  });

  // ----- the screenshot, public behind its key -----
  app.get('/api/reports/:id/image/:key', (req, res) => {
    const r = q.byId.get(Number(req.params.id));
    if (!r?.image || r.image_key !== req.params.key) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(imgDir, r.image));
  });
}
