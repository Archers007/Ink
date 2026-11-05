// duels.ink client (scaffold). duels.ink is another Lorcana site: an online play table with ranked queues, a card
// library, community decks, replays, puzzles and cups. Nothing in Ink calls this yet; it is here so that when we do,
// every request goes through lib/extcalls (source 'duels') and the same politeness rules as lib/dreamborn.js.
//
// What was found (2026-11-04, unauthenticated, by reading the site's JS bundles and watching the network calls its
// own pages make in a normal browser visit to /leaderboard, /cards and /decks/community; the API was not called
// directly from a script):
//
// Stack: a TanStack Start (React) single-page app behind Cloudflare. The HTML is a shell (no SSR data); every page
// loads its data from same-origin JSON endpoints under https://duels.ink/api/. Card images and rules PDFs come from
// https://cards.duels.ink (e.g. /lorcana/en/full/<id>.webp, /lorcana/en/thumbnail/<id>.webp, /rules/crd/en/*.pdf).
//
// robots.txt (the reason almost everything below is gated):
//   User-agent: *  Allow: /, but Disallow: /api/, /decks (re-allowing /decks/public and /decks/community),
//   /game/, /table/, /spectate/, /draft/, /puzzle/, /playgrounds, /workshop, /vault, /login, /account, /admin,
//   /feedback, /my-stats, /match-history,
//   and a full `Disallow: /` for AI crawlers: GPTBot, Google-Extended, CCBot, anthropic-ai, Bytespider, ClaudeBot.
//   Sitemap: https://duels.ink/sitemap.xml (~150 URLs: /, /cards, /leaderboard, /decks/public, /decks/community,
//   /learn, /coaches, /rules/<lang>/..., /rules/set-notes/..., /release-notes/..., /stats/coconut/...).
// So /api/ is off limits to automated clients. This module checks robots.txt before every request and refuses
// disallowed paths (throws, code 'DUELS_ROBOTS') unless robots checking is turned off with createDuels({
// respectRobots: false }) or INK_DUELS_IGNORE_ROBOTS=1. Only do that once duels.ink has said Ink may use the API.
// No terms of service page was found (only /privacy and /about). /about says the site is a free fan project under
// Ravensburger's Fan Content Policy, funded by Ko-fi and affiliate links (Metafy, TCGplayer, CardNexus). No rate-limit
// headers were seen; the API sits behind Cloudflare.
//
// Auth: Better Auth style session (GET /api/auth/get-session -> null when signed out), one "strictly necessary
// session cookie", sign-in only through OAuth (Google, Discord, Microsoft; /oauth/authorize). No API keys, no public
// token flow. Signed-out calls to user endpoints return 401 (seen: /api/feedback/unread-count,
// POST /api/matchmaking/heartbeat).
//
// Endpoints seen answering 200 while signed out (wired below, robots-gated):
//   GET /api/version            -> { buildId: '90d4fd0' }
//   GET /api/login-providers    -> { microsoft: true }
//   GET /api/leaderboard?queue=<queueId>&season=<seasonId>   (both optional; default queue core-bo1, current season)
//       -> { meta: { queueId, queue: { id, name, gameMode }, queues: { active: [queue], archived: [queue] },
//                    queueOverrides, minGamesRequired, seasons: { currentSeason: { id, number, name },
//                    pastSeasons: [{ id, number, name, shortName, endedAt }] }, mmrDistribution: [{ bucket, count }] },
//            leaderboard: [{ rank, userId, username|null, mmr, gamesPlayed, wins, losses, winRate, peakMmr,
//                            tier: { name, icon }, peakTier, isAnonymous, isInactive, supporterData, socialLinks }] }
//       queue objects: { id: 'core-bo1'|'core-bo3'|'infinity-bo1'|..., name, shortName, format: 'CoreConstructed'|
//         'InfinityConstructed'|..., gameMode: 'bo1'|'bo3', ranked, timerConfig: {...}, rewardTiers, activeSince, ... }
//   GET /api/cards?q=&<filter>=a,b&limit=200&offset=0
//       filters (comma-joined values): color, rarity, legality, inkable, type, subtype, cost, strength, willpower,
//       lore, moveCost, set, franchise, mechanic. (alpha=1 asks for unreleased cards and needs a session.)
//       -> { meta: { total: 3456, limit, offset, hasMore }, cards: [{ id: '4-DIS-1', fullId: '1/DIS EN 4', name,
//            title, fullName, slug, type, colors: ['sapphire'], cost, inkable, rarity, legality: ['core','infinity',..],
//            strength, willpower, lore, moveCost, abilities: [{ ability, value? }], specialAbilities: [{ name, slug,
//            effect }], subtypes, franchises, variants, cardmarket: { variant: id }, tcgplayer: { variant: id },
//            foil?, rulesText, flavorText, imageUrl, imageSmallUrl, thumbHash }] }
//       Card ids are '<set>-<number>' ('14-24') or '<set>-<promo set>-<number>' ('10-D23-14').
//   GET /api/decks/community?q=&colors=a,b&format=&excludeCore=1&sort=trending|newest&limit=24&offset=0
//       -> { decks: [{ id (uuid v7), name, cardCount, colors, secondaryColors, legalFormats: ['CoreConstructed',..],
//            visibility: 'public', likeCount, viewCount, copyCount, updatedAt, createdAt, valid, hasCustomCards,
//            type: 'constructed', ownerName, ownerId, wr, deckEntries: [{ cardId: '14-14', variant? }] (one entry
//            per copy) }] }
//   GET /api/prices             -> { cardmarket: { lastUpdated, currency: 'EUR', prices: { <cardmarketId>:
//                                    { regular, foil } } }, ... }   (large; keyed by the ids in cards[].cardmarket)
//   Also called on every page while signed out: /api/custom-cards/access, /api/cards/alpha-access,
//   /api/puzzle/highlight-notifications (not wired; per-session UI flags).
//
// Seen in the client code only (paths and params from the bundles; not observed, so stubs):
//   GET /api/decks/:id -> { deck } (404 -> missing); /api/decks/:id/stats -> { stats }; /api/decks/public?type=cube;
//   /api/stats/coconut?window=7d|30d|all; /api/puzzle/leaderboard?filter=; /api/cup, /api/cup/leaderboard;
//   /api/replay/:id (also ?format=zip, ?format=eval); /api/game/:id/logs?public=true; /api/spectate/games
//   -> { games }; /api/home/data -> { stats, openTables, liveGames, liveGamesCount }; /api/settings/public
//   -> { settings }; /api/seasons/resolve-link?fromSeasonId=&toQueueId=; /api/user/ranks/:id;
//   /api/og/* (share images).
// Needs a session (stubs): /api/me/match-history, /api/me/bulk-replays, /api/me/bulk-gamelogs, /api/decks (mine,
//   POST/PATCH), /api/account/*, /api/user/*, /api/friends/*, /api/matchmaking/* (join/leave/heartbeat/accept),
//   /api/game/create-bot-game, /api/game/invite, /api/game/:id/action (POST), /api/game/:id/ws-token.
//
// Websockets (described from the client code; never connected): wss://ws.duels.ink, two sockets, both need a
// short-lived token from a signed-in HTTP call first.
//   Game: GET /api/game/:id/ws-token?guest=&sessionId=&wsAttempt=&wsPrev= -> { token, wsUrl? }, then
//     `${wsUrl ?? 'wss://ws.duels.ink'}/game/:id?token=...`. Server -> client JSON messages by `type`: init and
//     game_update ({ game (with stateVersion), takenAction?, message?, buildId? }), action_result, game_log, rule,
//     error, heartbeat, player_connected, player_disconnected, spectator_count, transport. Client -> server:
//     { type: 'ping' } every 10 s and { type: 'action', action: { type: ... }, requestId, gameId } (10 s timeout,
//     with POST /api/game/:id/action as the HTTP fallback, e.g. { action: { type: 'CONCEDE' } }).
//   Presence: GET /api/me/presence-token -> { token, wsUrl? }, then `${wsUrl}/presence?token=...`; messages hello,
//     event, ping (answered with { type: 'pong', t }); reconnects with backoff up to 30 s.
//
// Politeness: at most 2 requests in flight and at least 250 ms between starts, like lib/dreamborn.js. The user-agent
// names Ink plainly instead of copying a browser's.

const DEFAULT_BASE = 'https://duels.ink';
const UA = 'Ink/0.1 (Lorcana deck builder; +https://ink.strmlight.com)';
const UA_TOKEN = 'ink';   // the product token robots.txt groups are matched against
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;

const HEADERS = {
  'accept': 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': UA,
};

// A tiny start-rate and concurrency limiter shared by every call one client makes.
function makeQueue({ maxInFlight = 2, minGapMs = 250 } = {}) {
  const waiting = [];
  let inFlight = 0;
  let lastStart = 0;
  let timer = null;
  const pump = () => {
    if (timer || !waiting.length || inFlight >= maxInFlight) return;
    const wait = lastStart + minGapMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; pump(); }, wait);
      return;
    }
    const { fn, resolve, reject } = waiting.shift();
    inFlight++;
    lastStart = Date.now();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { inFlight--; pump(); });
    pump();
  };
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); pump(); });
}

// robots.txt per RFC 9309: pick the group naming our product token (else '*'), then the longest matching rule wins,
// Allow winning a tie. Supports the * and $ wildcards.
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + re + (anchored ? '$' : '')).test(path);
}

export function robotsAllows(groups, path, token = UA_TOKEN) {
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const pick = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = pick.flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

class RobotsError extends Error {
  constructor(path) {
    super(`duels.ink: ${path} is disallowed by robots.txt for automated clients`);
    this.code = 'DUELS_ROBOTS';
  }
}

const notWired = (_name) => async () => { throw new Error('duels.ink: not wired yet'); };

// base: point at a stub server in tests. extFetch: inject a fake recorder in tests (defaults to lib/extcalls).
export function createDuels({
  base = process.env.INK_DUELS_BASE || DEFAULT_BASE,
  respectRobots = process.env.INK_DUELS_IGNORE_ROBOTS !== '1',
  extFetch = null,
  maxInFlight = 2,
  minGapMs = 250,
} = {}) {
  base = String(base).replace(/\/+$/, '');
  const queue = makeQueue({ maxInFlight, minGapMs });
  let fetcher = extFetch;
  const getFetch = async () => fetcher || (fetcher = (await import('./extcalls/index.js')).extFetch);

  let robots = null;   // { groups, at, ok }
  let robotsLoading = null;

  const send = (path, kind, { caller = 'duels', userId, ref, accept, keepBody = true } = {}) => queue(async () => {
    const f = await getFetch();
    const headers = accept ? { ...HEADERS, accept } : HEADERS;
    return f(base + path, { headers }, { source: 'duels', kind, caller, userId, ref, keepBody });
  });

  async function loadRobots(opts) {
    if (robots && Date.now() - robots.at < ROBOTS_TTL_MS) return robots;
    if (robotsLoading) return robotsLoading;
    robotsLoading = (async () => {
      try {
        const res = await send('/robots.txt', 'robots', { ...opts, accept: 'text/plain' });
        const text = await res.text();
        // 4xx: no robots file, everything allowed. 5xx: treat the site as fully disallowed, per RFC 9309.
        if (res.ok) robots = { groups: parseRobots(text), at: Date.now(), text };
        else if (res.status < 500) robots = { groups: [], at: Date.now(), text: '' };
        else robots = { groups: parseRobots('User-agent: *\nDisallow: /'), at: Date.now(), text: '' };
      } catch {
        robots = { groups: parseRobots('User-agent: *\nDisallow: /'), at: Date.now() - ROBOTS_TTL_MS + 60e3, text: '' };
      }
      return robots;
    })().finally(() => { robotsLoading = null; });
    return robotsLoading;
  }

  async function allowed(path, opts) {
    if (!respectRobots) return true;
    const r = await loadRobots(opts);
    return robotsAllows(r.groups, path.split('?')[0]);
  }

  async function getJSON(path, kind, opts = {}) {
    if (!(await allowed(path, opts))) throw new RobotsError(path.split('?')[0]);
    const res = await send(path, kind, opts);
    if (!res.ok) {
      const err = new Error(`duels.ink ${kind}: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  const qs = (params) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      u.set(k, Array.isArray(v) ? v.join(',') : v === true ? '1' : String(v));
    }
    const s = u.toString();
    return s ? `?${s}` : '';
  };

  return {
    base,

    // robots.txt itself (always fetchable). → { text, groups }
    async robots(opts = {}) {
      robots = null;
      const r = await loadRobots(opts);
      return { text: r.text, groups: r.groups };
    },

    // Is this path open to Ink under the current robots.txt? (false for anything under /api/ today)
    async isAllowed(path, opts = {}) { return allowed(path, opts); },

    // sitemap.xml (allowed by robots.txt). → { urls: ['https://duels.ink/cards', …] }
    async sitemap(opts = {}) {
      if (!(await allowed('/sitemap.xml', opts))) throw new RobotsError('/sitemap.xml');
      const res = await send('/sitemap.xml', 'sitemap', { ...opts, accept: 'application/xml' });
      if (!res.ok) throw new Error(`duels.ink sitemap: HTTP ${res.status}`);
      const xml = await res.text();
      return { urls: [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]) };
    },

    // Below: endpoints seen answering signed-out requests. All live under /api/, which robots.txt disallows, so these
    // throw DUELS_ROBOTS until robots checking is turned off with duels.ink's blessing.

    // → { buildId }
    version(opts) { return getJSON('/api/version', 'version', opts); },

    // → { microsoft: bool } (Google and Discord are always offered)
    loginProviders(opts) { return getJSON('/api/login-providers', 'login-providers', opts); },

    // → { meta: { queueId, queue, queues, seasons, mmrDistribution, … }, leaderboard: [{ rank, username, mmr, … }] }
    leaderboard({ queue, season } = {}, opts) {
      return getJSON('/api/leaderboard' + qs({ queue, season }), 'leaderboard', opts);
    },

    // filters: { color: ['amber'], set: [14], legality: ['core'], … } → { meta: { total, hasMore, … }, cards }
    cards({ q, filters = {}, limit = 200, offset = 0 } = {}, opts) {
      return getJSON('/api/cards' + qs({ q, ...filters, limit, offset }), 'cards', opts);
    },

    // → { decks: [{ id, name, colors, legalFormats, likeCount, viewCount, ownerName, deckEntries, … }] }
    communityDecks({ q, colors, format, excludeCore, sort, limit = 24, offset = 0 } = {}, opts) {
      return getJSON('/api/decks/community' + qs({ q, colors, format, excludeCore, sort, limit, offset }),
        'community-decks', opts);
    },

    // → { cardmarket: { lastUpdated, currency, prices: { id: { regular, foil } } }, … }
    prices(opts) { return getJSON('/api/prices', 'prices', opts); },

    // Seen in the site's code but not observed answering, so not wired.
    deck: notWired('deck'),                     // GET /api/decks/:id -> { deck }
    deckStats: notWired('deckStats'),           // GET /api/decks/:id/stats -> { stats }
    publicDecks: notWired('publicDecks'),       // GET /api/decks/public?type=cube
    coconutStats: notWired('coconutStats'),     // GET /api/stats/coconut?window=7d|30d|all
    puzzleLeaderboard: notWired('puzzleLeaderboard'), // GET /api/puzzle/leaderboard?filter=
    cupLeaderboard: notWired('cupLeaderboard'), // GET /api/cup/leaderboard
    replay: notWired('replay'),                 // GET /api/replay/:id (?format=zip|eval)
    gameLogs: notWired('gameLogs'),             // GET /api/game/:id/logs?public=true
    spectateGames: notWired('spectateGames'),   // GET /api/spectate/games -> { games }
    homeData: notWired('homeData'),             // GET /api/home/data
    publicSettings: notWired('publicSettings'), // GET /api/settings/public -> { settings }

    // Need a duels.ink session (OAuth only), so not wired.
    session: notWired('session'),               // GET /api/auth/get-session
    matchHistory: notWired('matchHistory'),     // GET /api/me/match-history?…&cursor=
    myDecks: notWired('myDecks'),               // GET /api/decks?includeCardIds=true
    gameSocket: notWired('gameSocket'),         // /api/game/:id/ws-token, then wss://ws.duels.ink/game/:id
    presenceSocket: notWired('presenceSocket'), // /api/me/presence-token, then wss://ws.duels.ink/presence
  };
}

export const DUELS_BASE = DEFAULT_BASE;
export const duels = createDuels();
