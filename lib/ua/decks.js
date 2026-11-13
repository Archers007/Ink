// Union Arena routes: the card list, deck checks, and players' UA decks.
//
// UA decks live in their own table (ua_decks) in data/ink.db, next to the Lorcana decks table, and use the same
// accounts (lib/accounts.js): the same sign-in, and a guest's first save makes a guest account for this browser.
//
//   GET    /api/ua/cards              every card def (game/ua/cards.js) + titles, ETag'd on the import time
//   POST   /api/ua/deck-check         { cards: [[no, qty]] } -> { problems: [] }
//   GET    /api/ua/my/decks           this player's UA decks
//   POST   /api/ua/my/decks           save { id?, name, cards, shared? }
//   DELETE /api/ua/my/decks/:id
//   GET    /api/ua/community/decks    UA decks account holders shared (?q=, ?src=)
//   GET    /api/ua/community/decks/:id

import { randomBytes } from 'node:crypto';
import { loadUaCards, deckProblems, DECK_RULES } from '../../game/ua/cards.js';

const MAX_DECKS = 200;
const token = (n = 9) => randomBytes(n).toString('base64url');

export function cleanUaDeck(body) {
  const name = String(body?.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  if (!name) throw new Error('deck needs a name');
  if (!Array.isArray(body.cards) || body.cards.length > 120) throw new Error('bad card list');
  const seen = new Map();
  for (const e of body.cards) {
    if (!Array.isArray(e) || e.length !== 2) throw new Error('bad card entry');
    const no = String(e[0]).trim().toUpperCase().slice(0, 32), qty = Math.floor(Number(e[1]));
    if (!/^[A-Z0-9]{2,4}-[A-Z0-9]+-[A-Z0-9]+$/.test(no) || !(qty >= 1 && qty <= 50)) throw new Error('bad card entry');
    seen.set(no, (seen.get(no) || 0) + qty);
  }
  const cards = [...seen];
  const cover = body.cover != null && seen.has(String(body.cover)) ? String(body.cover) : null;
  return { name, cards, cover };
}

// compact card list for the browser (no printings beyond their images)
function clientCards(idx) {
  return [...idx.defs.values()].map((d) => ({
    no: d.no, src: d.src, name: d.name, type: d.type, color: d.color, energy: d.energy, ap: d.ap, bp: d.bp,
    aff: d.affinities, gen: d.gen, genPlus: d.genPlus || undefined, rarity: d.rarity, img: d.img,
    alt: d.printings.length > 1 ? d.printings.filter((p) => p.img !== d.img).map((p) => p.img) : undefined,
    kw: Object.keys(d.kw).length ? d.kw : undefined, raid: d.raid || undefined,
    effect: d.effect, trigger: d.trigger || undefined,
  }));
}

export function attachUaDecks(app, { db, accounts }) {
  let cardsJson = null;
  const cards = () => {
    const idx = loadUaCards();
    if (!idx) return null;
    if (!cardsJson || cardsJson.mtime !== idx.mtime) {
      const body = JSON.stringify({ builtAt: idx.builtAt, titles: idx.titles, rules: DECK_RULES, cards: clientCards(idx) });
      cardsJson = { mtime: idx.mtime, etag: `"ua-${Math.round(idx.mtime)}"`, body };
    }
    return cardsJson;
  };

  app.get('/api/ua/cards', (req, res) => {
    const c = cards();
    if (!c) return res.status(503).json({ error: 'Union Arena cards are still being imported. Try again in a few minutes.' });
    res.set('ETag', c.etag);
    res.set('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
    res.type('json').send(c.body);
  });

  app.post('/api/ua/deck-check', (req, res) => {
    const idx = loadUaCards();
    if (!idx) return res.status(503).json({ error: 'cards not imported yet' });
    try {
      const d = cleanUaDeck({ name: 'check', cards: req.body?.cards || [] });
      res.json({ problems: deckProblems(d.cards, idx.defs) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  if (!db || !accounts?.userFromReq) {
    app.get('/api/ua/my/decks', (req, res) => res.status(503).json({ error: 'accounts are off' }));
    return { deck: () => null };
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ua_decks (
      id       TEXT PRIMARY KEY,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name     TEXT NOT NULL,
      src      TEXT,                   -- source material code (HTR, BLC…), from the cards
      cards    TEXT NOT NULL,          -- JSON [[cardNo, qty], …]
      cover    TEXT,
      shared   INTEGER NOT NULL DEFAULT 0,
      created  INTEGER NOT NULL,
      updated  INTEGER NOT NULL,
      UNIQUE (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_ua_decks_user ON ua_decks(user_id);
    CREATE INDEX IF NOT EXISTS idx_ua_decks_shared ON ua_decks(shared, updated);
  `);
  const q = {
    mine: db.prepare('SELECT id, name, src, cards, cover, shared, updated FROM ua_decks WHERE user_id = ? ORDER BY updated DESC'),
    count: db.prepare('SELECT COUNT(*) AS n FROM ua_decks WHERE user_id = ?'),
    byId: db.prepare('SELECT id, name, src, cards, cover, shared, updated FROM ua_decks WHERE id = ? AND user_id = ?'),
    byName: db.prepare('SELECT id FROM ua_decks WHERE user_id = ? AND name = ?'),
    insert: db.prepare('INSERT INTO ua_decks (id, user_id, name, src, cards, cover, shared, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE ua_decks SET name = ?, src = ?, cards = ?, cover = ?, shared = ?, updated = ? WHERE id = ? AND user_id = ?'),
    drop: db.prepare('DELETE FROM ua_decks WHERE id = ? AND user_id = ?'),
    shared: db.prepare(`SELECT d.id, d.name, d.src, d.cards, d.cover, d.updated, u.name AS author FROM ua_decks d JOIN users u ON u.id = d.user_id
      WHERE d.shared = 1 AND u.guest = 0 AND (? = '' OR d.src = ?) AND (? = '' OR d.name LIKE ? OR u.name LIKE ?) ORDER BY d.updated DESC LIMIT 31 OFFSET ?`),
    sharedOne: db.prepare('SELECT d.id, d.name, d.src, d.cards, d.cover, d.updated, u.name AS author FROM ua_decks d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.shared = 1 AND u.guest = 0'),
    any: db.prepare('SELECT id, name, src, cards, cover, shared, updated, user_id FROM ua_decks WHERE id = ?'),
  };
  const out = (d) => ({ id: d.id, name: d.name, src: d.src, cards: JSON.parse(d.cards), cover: d.cover, shared: !!d.shared, updated: d.updated, ...(d.author ? { author: d.author } : {}) });
  const srcOf = (list) => {
    const idx = loadUaCards();
    const s = new Set(list.map(([no]) => idx?.defs.get(no)?.src || no.split('-')[0]));
    return s.size === 1 ? [...s][0] : null;
  };

  app.get('/api/ua/my/decks', (req, res) => {
    const u = accounts.userFromReq(req);
    res.set('Cache-Control', 'no-store');
    res.json({ decks: u ? q.mine.all(u.id).map(out) : [] });
  });
  app.post('/api/ua/my/decks', (req, res) => {
    const u = accounts.ensureUser ? accounts.ensureUser(req, res) : accounts.userFromReq(req);
    if (!u) { if (!res.headersSent) res.status(401).json({ error: 'not signed in' }); return; }
    try {
      const d = cleanUaDeck(req.body);
      const wantShared = typeof req.body?.shared === 'boolean' ? req.body.shared : null;
      if (wantShared && u.guest) throw new Error('Create an account to share decks.');
      const json = JSON.stringify(d.cards), now = Date.now(), src = srcOf(d.cards);
      const existing = req.body.id ? q.byId.get(String(req.body.id), u.id) : null;
      const clash = q.byName.get(u.id, d.name);
      let id;
      if (existing) {
        if (clash && clash.id !== existing.id) q.drop.run(clash.id, u.id);
        id = existing.id;
        q.update.run(d.name, src, json, d.cover, wantShared ?? existing.shared ? 1 : 0, now, id, u.id);
      } else if (clash) {
        id = clash.id;
        const cur = q.byId.get(id, u.id);
        q.update.run(d.name, src, json, d.cover, wantShared ?? cur.shared ? 1 : 0, now, id, u.id);
      } else {
        if (q.count.get(u.id).n >= MAX_DECKS) throw new Error(`deck limit reached (${MAX_DECKS})`);
        id = token();
        q.insert.run(id, u.id, d.name, src, json, d.cover, wantShared ? 1 : 0, now, now);
      }
      res.json({ deck: out(q.byId.get(id, u.id)), user: accounts.publicUser ? accounts.publicUser(u) : null });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/ua/my/decks/:id', (req, res) => {
    const u = accounts.userFromReq(req);
    if (!u) return res.status(401).json({ error: 'not signed in' });
    q.drop.run(String(req.params.id), u.id);
    res.json({ ok: true });
  });
  app.get('/api/ua/community/decks', (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 60);
    const src = String(req.query.src || '').trim().toUpperCase().slice(0, 4);
    const like = `%${term.replace(/[%_]/g, '')}%`;
    const page = Math.max(1, Math.min(200, Number(req.query.page) || 1));
    const rows = q.shared.all(src, src, term, like, like, (page - 1) * 30).map(out);
    res.set('Cache-Control', 'no-store');
    res.json({ decks: rows.slice(0, 30), page, more: rows.length > 30 });
  });
  app.get('/api/ua/community/decks/:id', (req, res) => {
    const d = q.sharedOne.get(String(req.params.id));
    if (!d) return res.status(404).json({ error: 'no such shared deck' });
    res.json({ deck: out(d) });
  });

  return {
    // a deck the player owns, or one anyone shared (the table and the bot read decks through this)
    deck(u, id) {
      const d = q.any.get(String(id));
      if (!d) return null;
      if (d.shared || (u && d.user_id === u.id)) return out(d);
      return null;
    },
    mine: (u) => (u ? q.mine.all(u.id).map(out) : []),
  };
}
