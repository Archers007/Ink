// dreamborn.ink deck pages: the Nuxt 3 SSR payload a deck page embeds, resolved into a plain deck object with the
// decklist (pbCode "Name_Subtitle$qty|…" and the card-id map). Used by server.js (/api/decks/:id) and
// tools/fetch-meta-decks.mjs.
export const DREAMBORN_DECKS = 'https://dreamborn.ink/api/v2/decks';
export const DREAMBORN_DECK_PAGE = (id) => `https://dreamborn.ink/decks/${encodeURIComponent(id)}`;

// Pull the Nuxt 3 SSR payload out of dreamborn's HTML and resolve the dedup'd
// references back into a plain deck object. The Nuxt payload is a JSON array
// where compound values reference each other by integer index.
export function parseDreambornDeckHTML(html, id) {
  const arr = extractNuxtPayloadArray(html);
  if (!arr) return null;
  const deckObj = findDeckObject(arr, id);
  if (!deckObj) return null;

  // Nuxt 3 SSR payload stores every value at an integer index; an integer
  // field value means "look up arr[idx]".  Resolve exactly one step.
  const ref = (v) => {
    if (typeof v !== 'number' || v < 0 || v >= arr.length) return v;
    return arr[v];
  };
  // Resolve array of refs (e.g. colors list).
  const refArr = (idx) => {
    const a = ref(idx);
    if (!Array.isArray(a)) return [];
    return a.map((x) => ref(x));
  };
  // Resolve key/value object whose values are refs.
  const refObj = (idx) => {
    const o = ref(idx);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = ref(v);
    return out;
  };

  const name        = ref(deckObj.name);
  const creator     = ref(deckObj.creator);
  const creatorName = ref(deckObj.creatorName);
  const colors      = refArr(deckObj.colors);
  const size        = ref(deckObj.size);
  const lastUpdated = ref(deckObj.lastUpdated);
  const likeCount   = ref(deckObj.likeCount);
  const views       = ref(deckObj.views);
  const description = ref(deckObj.description);
  const formats     = refArr(deckObj.formats);
  const pbCode      = ref(deckObj.pbCode);
  const tags        = refObj(deckObj.tags);
  const cardsMap    = refObj(deckObj.cards);  // { dreambornCardId: qty }

  // Decode the deck list from pbCode (Name_Subtitle$Qty|...).
  const cards = [];
  if (typeof pbCode === 'string') {
    try {
      const decoded = Buffer.from(pbCode, 'base64').toString('utf8');
      for (const entry of decoded.split('|')) {
        if (!entry) continue;
        const m = entry.match(/^(.+?)\$(\d+)$/);
        if (!m) continue;
        const left = m[1];
        const qty  = Number(m[2]);
        const us   = left.indexOf('_');
        const cardName  = us >= 0 ? left.slice(0, us) : left;
        const cardTitle = us >= 0 ? left.slice(us + 1) : '';
        cards.push({ name: cardName, title: cardTitle, qty });
      }
    } catch (e) {
      console.warn('[deck] pbCode decode failed:', e.message);
    }
  }

  return {
    id,
    name: typeof name === 'string' ? name : null,
    creator: typeof creator === 'string' ? creator : null,
    creatorName: typeof creatorName === 'string' ? creatorName : null,
    description: typeof description === 'string' ? description : '',
    colors: colors.filter((c) => typeof c === 'string'),
    size: Number(size) || cards.reduce((a, c) => a + c.qty, 0),
    lastUpdated: typeof lastUpdated === 'string' ? lastUpdated : null,
    likeCount: Number(likeCount) || 0,
    views:     Number(views)     || 0,
    formats: formats.filter((f) => typeof f === 'number' || typeof f === 'string'),
    cardIds: Object.entries(cardsMap).map(([cid, qty]) => ({ id: cid, qty: Number(qty) || 0 })),
    cards,
    pbCode: typeof pbCode === 'string' ? pbCode : null,
    sourceUrl: `https://dreamborn.ink/decks/${id}`,
  };
}

function extractNuxtPayloadArray(html) {
  // The Nuxt 3 serialized payload is embedded in a <script>[...]</script> block.
  // We look for one that starts with `[["ShallowReactive"` which is the marker
  // for the reactive store payload.
  const re = /<script[^>]*>(\[\s*\[\s*"ShallowReactive"[\s\S]*?\])<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) return arr;
    } catch { /* skip */ }
  }
  return null;
}

function findDeckObject(arr, expectedId) {
  // The deck record is an object whose keys include name, creator, cards, pbCode.
  for (const v of arr) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'pbCode' in v && 'cards' in v && 'creator' in v) {
      return v;
    }
  }
  // Fallback: find by id reference
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === expectedId) {
      // walk for an object that references this index as `id`
      for (const v of arr) {
        if (v && typeof v === 'object' && !Array.isArray(v) && v.id === i) return v;
      }
    }
  }
  return null;
}
