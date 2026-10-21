// One resolving ability in the bag (s.fx). Plain JSON so it survives the engine's snapshot/rollback.
//   steps  the proc's steps (cloned)    i     current step
//   ctx    { it: last things acted on, did: last step happened, declined, healed }
//   tmp    per-step scratch (target picks so far)    answer  the player's last choice, keyed by waitKey
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
export const Job = {
  make(seat, src, label, steps, ctx = {}, extra = {}) {
    return { seat, src, label, steps: clone(steps), i: 0, ctx: { it: [], did: true, ...ctx }, tmp: {}, ...extra };
  },
  next(job) { job.i++; job.tmp = {}; job.answer = null; },
};
