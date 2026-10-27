// What the bot's learned evaluator looks at: a fixed-length description of a position from one seat's side, using
// only what that seat can see (counts for the opponent's hidden zones, never their cards).
import { D } from '../engine.js';
import { effLore, effStr, effWp } from '../../public/js/play/rules.js';

export const FEATURES = [
  'my lore', 'their lore', 'my lore past 14', 'their lore past 14',
  'my characters', 'their characters', 'my quest lore', 'their quest lore',
  'my strength', 'their strength', 'my willpower left', 'their willpower left',
  'my hand', 'their hand', 'my ink', 'their ink', 'my items+locations', 'their items+locations',
  'my deck low', 'their deck low', 'turn',
];

function side(s, p) {
  let chars = 0, lore = 0, str = 0, wp = 0, other = 0;
  for (const iid of p.play) {
    const c = s.cards[iid], d = D(s, c);
    if (d.type === 'character') { chars++; lore += Math.max(0, effLore(c, d)); str += Math.max(0, effStr(c, d)); wp += Math.max(0, effWp(c, d) - c.damage); }
    else other++;
  }
  return { chars, lore, str, wp, other };
}

export function features(s, seat) {
  const me = s.players[seat], them = s.players.find((p) => p.seat !== seat);
  const a = side(s, me), b = side(s, them);
  return [
    me.lore / 20, them.lore / 20, Math.max(0, me.lore - 14) / 6, Math.max(0, them.lore - 14) / 6,
    a.chars / 6, b.chars / 6, a.lore / 8, b.lore / 8,
    a.str / 15, b.str / 15, a.wp / 20, b.wp / 20,
    me.hand.length / 7, them.hand.length / 7, Math.min(me.inkwell.length, 10) / 8, Math.min(them.inkwell.length, 10) / 8,
    a.other / 4, b.other / 4, me.deck.length < 5 ? 1 : 0, them.deck.length < 5 ? 1 : 0, Math.min(s.turn, 30) / 20,
  ];
}
