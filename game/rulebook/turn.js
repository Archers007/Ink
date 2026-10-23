// The turn structure (CR 3) as data: phases, their steps in order, the CR section for each, and the rule a card can
// change to skip it. The engine owns what each step does (game/engine.js STEPS); this file owns the order and when
// the bag resolves, so the game flow reads like the rulebook:
//
//   step   id the engine implements            cr    the section that defines it
//   rule   RULES id (rules.js); false → skipped (6.4.3: a skipped step doesn't happen)
//   bag    triggers added up to here resolve before the next step (3.2.2.3, 3.4.1.1, 3.4.1.2)
//   first  'skip' — the starting player skips it on the game's first turn (3.2.3.1)
export const TURN = {
  start: {
    cr: '3.2', say: 'Start-of-Turn Phase',
    steps: [
      { step: 'begin', cr: '1.3.4.1', say: 'become the active player' },
      { step: 'ready', cr: '3.2.1', say: 'Ready' },                        // 3.2.1.1 ready · 3.2.1.3 "until the start of your turn" ends
      { step: 'set', cr: '3.2.2', say: 'Set' },                            // 3.2.2.1 drying ends · 3.2.2.2 location lore
      { step: 'startTriggers', cr: '3.2.1.4', say: '"at the start of your turn"', bag: true },
      { step: 'check', cr: '1.9.1', say: 'game state check' },
      { step: 'draw', cr: '3.2.3', say: 'Draw', rule: 'drawStep', first: 'skip' },
    ],
  },
  main: { cr: '3.3', say: 'Main Phase' },                                 // 4.1: turn actions, until the player ends the turn (3.3.2)
  end: {
    cr: '3.4', say: 'End-of-Turn Phase',
    steps: [
      { step: 'endTriggers', cr: '3.4.1.1', say: '"at the end of your turn"', bag: true },
      { step: 'cleanup', cr: '3.4.1.2', say: '"this turn" effects end' },
      { step: 'deckOut', cr: '1.8.1.2', say: 'a player who ends their turn with no deck loses' },
      { step: 'check', cr: '3.4.2', say: 'final game state check' },
      { step: 'pass', cr: '3.4.2', say: 'the next player starts their turn' },
    ],
  },
};
export const PHASES = ['start', 'main', 'end'];                          // 3.1.1

// Run `phase` from step index `at`. STEPS[id](s, seat, ev) does the work; when a `bag` step queued abilities, the
// rest of the phase waits behind them (queueRest), so they resolve first — the bag is empty before the next step.
//   rule(s, id, seat) → rule value   pending(s) → abilities waiting   queueRest(s, seat, phase, at)
export function runPhase(s, seat, ev, phase, at, { STEPS, rule, pending, queueRest, stopped }) {
  const steps = TURN[phase].steps;
  for (let i = at; i < steps.length; i++) {
    const st = steps[i];
    s.step = st.step;
    if (st.rule && rule(s, st.rule, seat) === false) { STEPS.skipped(s, seat, ev, st); continue; }
    if (st.first === 'skip' && s.turn === 1 && seat === s.starting) { STEPS.skipped(s, seat, ev, st, 'first'); continue; }
    const before = pending(s);
    STEPS[st.step](s, seat, ev);
    if (stopped(s)) return false;
    if (st.bag && pending(s) > before && i + 1 < steps.length) { queueRest(s, seat, phase, i + 1); return false; }
  }
  s.step = phase === 'start' ? 'main' : null;
  return true;
}
