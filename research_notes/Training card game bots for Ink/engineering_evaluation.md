# Engineering and evaluation of a game-playing AI on a Node.js rules engine

Notes compiled 2026-11-23. Three kinds of evidence are kept apart throughout:

- **[measured here]** = benchmarks I ran this session in the research sandbox (4 vCPU Intel Xeon @ 2.10 GHz, Node v22.23.5, one thread) against the real Ink engine. The owner's PC will be faster in absolute terms; ratios should carry over. Scripts are in the session scratchpad (ephemeral): `/tmp/claude-0/-home-user-Ink/82a15bf0-7ed5-5b36-9958-b7e32eb733fd/scratchpad/bench/clone-bench.mjs`, `/tmp/claude-0/-home-user-Ink/82a15bf0-7ed5-5b36-9958-b7e32eb733fd/scratchpad/bench/clone-bench2.mjs`, `/tmp/claude-0/-home-user-Ink/82a15bf0-7ed5-5b36-9958-b7e32eb733fd/scratchpad/bench/stats.mjs`, `/tmp/claude-0/-home-user-Ink/82a15bf0-7ed5-5b36-9958-b7e32eb733fd/scratchpad/ortbench/bench.mjs`.
- **[computed here]** = my own arithmetic or simulation from standard formulas (source of the formula cited).
- Everything else is cited to a web source. Where I only saw a search-engine summary rather than the page itself, the bullet says so.

## 1. Fast simulation in JavaScript: alternatives to structuredClone, WASM/Rust ports, V8 pitfalls

### Takeaway
The cheapest large win is not a new data structure: 56% of the Ink state's bytes are immutable card definitions (`defs`) that get deep-copied on every clone. Sharing `defs` by reference and using a hand-written clone cut clone time from ~575 µs to ~70 µs (8x) in my measurement, with no engine rewrite. Make/unmake (reversible instruction lists) is what the strongest comparable project (Foul Play's Rust `poke-engine`) uses, but it is a much bigger change; a Rust/WASM port is only worth it if the whole search loop moves, because boundary crossings eat the gains.

### Cited Findings
- **[measured here]** A real mid-game Ink state (turn 9, two sim decks) serialises to 91,465 bytes of JSON: `defs` 51,186 bytes, `cards` 31,470 (120 card instances, ~262 bytes each), `log` 7,275, `players` 1,238. So about 64% of the state (`defs` + `log`) is data search never needs to copy. — local benchmark `clone-bench.mjs` (path above)
- **[measured here]** Clone cost per operation on that state, single thread:

  | Method | µs/op | vs structuredClone |
  |---|---|---|
  | `structuredClone(state)` | 570–576 | 1.0x |
  | `JSON.parse(JSON.stringify(state))` | 852 | 0.67x (slower) |
  | `v8.deserialize(v8.serialize(state))` | 858 | 0.67x (slower) |
  | Generic recursive clone (plain `for…in` / array loop), full state | 164–206 | 2.8–3.5x |
  | `structuredClone` of state minus `defs` and `log`, `defs` shared by reference | 139 | 4.1x |
  | Generic recursive clone, `defs` shared, `log` dropped | 69 | 8.3x |

  — local benchmarks `clone-bench.mjs` and `clone-bench2.mjs` (paths above)
- **[observed in repo]** `applyAction` takes a full `structuredClone` backup of the state for rollback on every call unless `opts.scratch` is set (`/home/user/Ink/game/engine.js` line 1198). The search bot passes `scratch`, but it clones once per determinization (`/home/user/Ink/game/searchbot.js` line 51) and once per candidate move in `legalMoves` (line 128), i.e. legality is tested by clone-and-try. It also uses `Math.random()` for determinization shuffles and for reseeding the engine RNG (lines 47–53), so search is not reproducible from a seed.
- web.dev notes that in a 2018 comparison `JSON.parse` was the fastest deep copy for very small objects, and recommends `structuredClone` as the robust default; it gives no current numbers. On the 91 KB Ink state the JSON round trip was slower than `structuredClone`, so that folklore does not apply here. — [web.dev](https://web.dev/articles/structured-clone); local benchmark above
- Foul Play (the search bot that won the Gen 9 OU track of the NeurIPS 2025 PokéAgent Challenge) rewrote its Python battle engine in Rust "to enable fast search", and the engine does not copy states: it "returns a list of instructions that mutate the state and can be reversed", because "copying states is costly". — [Foul Play write-up](https://pmariglia.github.io/posts/foul-play); [PokéAgent Challenge paper](https://arxiv.org/html/2603.15563)
- The `poke-engine` README sample shows a 100 ms search budget reaching 25,000 MCTS iterations (search-engine summary of the README; no Python-vs-Rust speedup figure is published). — [poke-engine](https://github.com/pmariglia/poke-engine)
- Chess engines use two patterns: **copy-make** (copy the small irreversible part of the state into a per-ply array; unmake is just decrementing the ply) and **make/unmake** (one global state, push old values on a stack, restore on unmake). The Chess Programming Wiki describes the trade-off as copy cost per make versus "higher memory bandwidth for copying back and forth" and restore logic; it gives no speed numbers. — [Chess Programming Wiki: Copy-Make](https://www.chessprogramming.org/Copy-Make)
- A 2018 Hearthstone paper reports a purpose-built C++ simulator running "10K full games per second, on average" — two orders of magnitude above Ink's ~80 games/s per core, which shows the ceiling for a native engine built for search. — [Świechowski & Tajmajer, arXiv 1808.04794](https://arxiv.org/pdf/1808.04794) (figure seen via search summary)
- V8 stores object properties in three tiers: in-object (fastest), fast out-of-object array (lookup through the hidden class's descriptor array), and slow dictionary mode. Inline caches do not work with dictionary-mode objects. Objects that receive the same properties in the same order share a hidden class; adding and deleting many properties pushes an object into dictionary mode; arrays with holes ("holey") are slower than packed ones, and mixing element types changes the element kind. — [V8 blog: Fast properties](https://v8.dev/blog/fast-properties); [V8 docs: hidden classes](https://v8.dev/docs/hidden-classes)
- Secondary sources put the inline-cache limit at about 4 shapes per call site before it goes megamorphic, and one Russian-language benchmark reports ~8.5 ns for a megamorphic read versus ~56 ns for a read from an object that had `delete` applied (dictionary mode), with the `delete` penalty growing from ~5x to ~14x on Node 24. These are single blog benchmarks, not V8 documentation. — [Habr article](https://habr.com/ru/articles/1066944/) (unverified, via search summary)
- Rust/WASM versus optimised JS: reports are anecdotal and mixed. One developer's Rust-WASM JSON parser lost to a TypeScript version by ~25% because serialisation across the boundary "ate most of our gains"; a Figma plugin author measured 0.90–1.04x (no difference) until pixel data was kept inside WASM memory; a Rust forum thread concludes the JS↔Rust interaction is usually the slow part. — [DEV: Rust WASM vs TypeScript](https://dev.to/kunal_d6a8fea2309e1571ee7/rust-wasm-vs-typescript-performance-why-the-faster-language-lost-by-25-2026-4n51); [Figma plugin post](https://levelup.gitconnected.com/wasm-didnt-make-my-figma-plugin-faster-it-made-it-possible-bb5b391e489a); [Rust users forum](https://users.rust-lang.org/t/rust-webassembly-is-slower-than-javascript/96182)

### Inferences
- With the owner's figures (clone 0.67 ms; ~7,500 actions/s ≈ 133 µs per action), one clone currently costs as much as ~5 engine actions. After sharing `defs` and hand-cloning (~70 µs here), a clone costs about half an action, so rollout/evaluation work becomes the bottleneck rather than copying. This is the highest value-per-effort change found in this research.
- Order of work that follows from the measurements: (1) keep `defs` outside the cloned state or share it by reference, and drop/truncate `log` in search copies; (2) hand-written clone specialised to the state shape (construct each card with a fixed literal so hidden classes stay monomorphic); (3) replace clone-and-try legality with a pure `isLegal(state, action)` predicate or generate only legal moves; (4) only then consider make/unmake or copy-on-write for `cards`.
- Copy-on-write per card (clone the `cards` map shallowly, copy a card object only when an action writes to it) fits card games well because one action touches a handful of the 120 cards. It needs every engine write to go through a helper, which is an audit of a 1,331-line engine. Make/unmake has the same audit cost plus undo for triggered effects; Foul Play's experience says it pays off, but that was done as part of a full engine rewrite.
- A typed-array state (struct-of-arrays, card instance = integer index) would make cloning a few `TypedArray.set` calls (single-digit microseconds for ~10 KB) and would be shareable through `SharedArrayBuffer`, but it means rewriting the engine and all card procs; not sensible for a solo developer while the JS-object engine is also the production rules engine.
- A Rust/WASM port is unattractive here: card behaviour lives in JS procs, so a WASM search core would call back into JS constantly, which is exactly the chatty-boundary pattern the anecdotes above show losing.
- Object pooling mainly reduces GC pressure from short-lived clones; once clones are ~30 KB of small objects instead of ~90 KB, young-generation GC should already be cheaper. I found no card-game-specific numbers for pooling.

### Gaps
- No published, controlled benchmark of structuredClone versus persistent structures (Immer, Immutable.js) versus make/unmake for game-tree search in JS was found; the only hard numbers are the local ones above. Immer is actively maintained (v11.2.10, 2026-11-10 per [npm registry](https://registry.npmjs.org/immer)) but I did not measure it.
- Whether `s.defs` is ever written after `newGame` (e.g. for tokens or copied cards) was not verified; `engine.js` line 455 writes it during setup. If it is mutated mid-game, share it with a shallow copy of the map rather than by bare reference.
- No measured Python-to-Rust speedup for `poke-engine`, and no numbers for V8 megamorphism on Ink's actual hot paths (would need `--cpu-prof` / `--trace-deopt` on the engine).
- My scripted self-play loop ran at ~1,160 actions/s in the sandbox (including the scripted bot's decision time), versus the owner's 7,500/s; the two are not directly comparable and I did not profile the difference.

## 2. Parallel search in Node: worker pools, root vs. tree parallelization

### Takeaway
Root parallelization (independent searches in separate workers, statistics summed at the root) is the right fit for Node: it needs no shared memory, and in the classic measurement it scaled better than tree parallelization (strength-speedup 14.9 at 16 threads versus 8.5). The bot already samples determinizations independently, so fanning those samples across a worker pool is nearly free to implement.

### Cited Findings
- Chaslot, Winands & van den Herik (2008), Go program Mango on 13x13 against GNU Go, 1 s per move, 2,000 games per setting (500–2,000 for some rows). "Strength-speedup" = how much more single-thread time would give the same win rate. Tables read directly from the paper:

  | Method | 2 threads | 4 threads | 16 threads |
  |---|---|---|---|
  | Leaf parallelization (strength-speedup) | 1.2 | 1.7 | 2.4 |
  | Root parallelization | 3.0 | 6.5 | 14.9 |
  | Tree, global mutex | 1.6 | 3.0 | 2.6 |
  | Tree, local mutexes | 1.9 | 3.0 | 3.3 |
  | Tree, local mutexes + virtual loss | 2.0 | 3.6 | 8.5 |

  Win rate against GNU Go went 26.7% (1 thread) → 56.5% (16 threads, root). — [Chaslot et al. 2008](https://dke.maastrichtuniversity.nl/m.winands/documents/multithreadedMCTS2.pdf)
- The same paper cautions that root parallelization's super-linear result (6.5 at 4 threads) came from escaping local optima at that particular UCT constant and short time setting; on 9x9 with 4 threads, root and tree were statistically indistinguishable (e.g. 60.2% vs 63.9% at 0.25 s, 250 games each). — [Chaslot et al. 2008](https://dke.maastrichtuniversity.nl/m.winands/documents/multithreadedMCTS2.pdf)
- The same paper's single-thread scaling curve: rating versus GNU Go fitted `Elo = 56.7·log2(T) − 175.2` (R² = 0.9922) for T = 1–16 s, i.e. about 57 Elo per doubling of thinking time. — [Chaslot et al. 2008](https://dke.maastrichtuniversity.nl/m.winands/documents/multithreadedMCTS2.pdf)
- Later work (Mirsoleimani et al.) reports tree parallelization reaching near-perfect playout speedup up to 16 threads on a Xeon with lock-free structures, i.e. the 2008 tree-parallel numbers are implementation-dependent (seen via search summary only). — [Mirsoleimani et al., arXiv 1605.04447](https://arxiv.org/pdf/1605.04447)
- Foul Play uses root-parallelized MCTS over sampled hidden-information states with a hand-written evaluation function instead of rollouts, and that design won a 2025 competition track against RL and LLM entries. — [Foul Play write-up](https://pmariglia.github.io/posts/foul-play); [PokéAgent Challenge paper](https://arxiv.org/html/2603.15563)
- Node's documentation: worker threads help CPU-intensive JavaScript, not I/O; use a pool because creating a Worker per task costs more than it saves; data passed by `postMessage`/`workerData` is copied with the HTML structured clone algorithm; memory is shared only by transferring `ArrayBuffer`s or sharing `SharedArrayBuffer`s. — [Node.js v22 worker_threads docs](https://nodejs.org/download/release/v22.11.0/docs/api/worker_threads.html)
- Maintained pool libraries as of this date: `piscina` 5.3.2 (2026-08-28, requires Node ≥ 20) and `tinypool` 2.2.0 (2026-09-13, Node ≥ 20). — [npm registry: piscina](https://registry.npmjs.org/piscina); [npm registry: tinypool](https://registry.npmjs.org/tinypool)

### Inferences
- Because every plain-object state must be structured-cloned across `postMessage`, shipping the root state to N workers costs roughly one clone each (~0.14–0.6 ms here, less once `defs` stays resident in each worker). That is negligible against a 450 ms budget, so SharedArrayBuffer is not needed for root parallelization. It would only matter for tree parallelization (a shared tree in typed arrays with `Atomics`), which is a research project in JS and not justified by the numbers above.
- Expected scaling: with independent determinization samples, K workers give ~K times the samples in the same wall time. Going by the Chaslot fit (57 Elo per doubling for that program), 8 workers would be worth on the order of three doublings; the actual figure for Ink must be measured with a budget-scaling experiment (section 6), since a bot whose evaluation is the weak point gains little from more samples.
- Keeping the server responsive: the web server's event loop is unaffected by workers as long as search never runs on the main thread, but all workers share the CPU with the Express process and the Docker host. Practical guard rails: cap the pool at physical cores minus 2, give live games a small dedicated pool and run arena/self-play in a separate process (or container with a CPU quota) at low priority, and monitor event-loop delay with `perf_hooks.monitorEventLoopDelay`.
- A per-decision deadline should be enforced in the main thread (take whatever statistics have arrived at 450 ms) rather than trusting each worker to stop on time.

### Gaps
- Cazenave & Jouandeau's original root-parallelization papers were not retrieved; only Chaslot's comparison and Cazenave's later Batch MCTS paper were.
- No measurements of `postMessage` overhead or piscina throughput from a primary source; a DEV article quoting "120 ms for 10 MB" cited unverifiable Node 26 details and was discarded.
- No published scaling numbers for root-parallel determinized MCTS in a trading card game specifically.

## 3. Running a trained model inside Node

### Takeaway
`onnxruntime-node` is the clear choice in 2026: actively released (v1.31.1, 2026-10-26), CPU provider on every platform, and measured at ~21–26 µs per single call for small MLPs, dropping below 1–4 µs per evaluation when batched. TensorFlow.js has had no release since October 2024. For a small value network, CPU inference is so cheap relative to engine cost that a GPU, batching queues and virtual loss are unnecessary; a hand-rolled Float32Array forward pass is a workable zero-dependency fallback only for tiny nets.

### Cited Findings
- `onnxruntime-node` latest is 1.31.1, published 2026-10-26, with releases roughly monthly through 2026 (1.27.0 on 06-19, 1.29.0 on 08-24, 1.30.0 on 09-14); `onnxruntime-web` is at the same version. — [npm registry: onnxruntime-node](https://registry.npmjs.org/onnxruntime-node); [npm registry: onnxruntime-web](https://registry.npmjs.org/onnxruntime-web)
- The 1.31.1 package README: works on Node v16+ (v20+ recommended). Prebuilt execution providers: CPU on Windows/Linux/macOS x64 and arm64; DirectML on Windows only; CUDA on Linux x64 only (CUDA v12; "CUDA v11 is no longer supported since v1.22"); WebGPU "currently experimental" on most platforms; CoreML on macOS; Linux x64 can also use TensorRT. CUDA binaries are downloaded at install unless `--onnxruntime-node-install=skip` is passed. — [onnxruntime-node 1.31.1 README](https://unpkg.com/onnxruntime-node@1.31.1/README.md)
- The onnxruntime.ai docs page still lists "CUDA v11.8" for Linux x64 and omits WebGPU/CoreML; it is stale relative to the package README. — [ONNX Runtime docs: Node.js](https://onnxruntime.ai/docs/get-started/with-javascript/node.html); contradicted by [package README](https://unpkg.com/onnxruntime-node@1.31.1/README.md)
- TensorFlow.js: the latest release of `@tensorflow/tfjs`, `@tensorflow/tfjs-node` and `@tensorflow/tfjs-node-gpu` is 4.22.0, published 2024-10-21 — no release in the 25 months since. The package still declares `engines: node >= 8.11.0`. Snyk lists tfjs-node maintenance as "Inactive" on one of its pages. — [npm registry: @tensorflow/tfjs-node](https://registry.npmjs.org/@tensorflow%2ftfjs-node); [tfjs releases](https://github.com/tensorflow/tfjs/releases); [Snyk advisor](https://snyk.io/advisor/npm-package/@tensorflow/tfjs-node)
- **[measured here]** Latency of float32 MLPs (Gemm + ReLU, tanh output; opset 17), `onnxruntime-node` 1.31.1 CPU provider with `intraOpNumThreads: 1`, versus a naive pure-JS forward pass (dense loops over `Float32Array`, preallocated buffers). Outputs matched to 1e-4.

  | Network (params) | Pure JS, 1 eval | ORT batch 1 | ORT batch 16 | ORT batch 64 | ORT batch 256 |
  |---|---|---|---|---|---|
  | 256-128-64-1 (41 k) | 55 µs | 21 µs | 28 µs (1.8 µs/eval) | 60 µs (0.9 µs/eval) | 196 µs (0.8 µs/eval) |
  | 512-256-256-1 (197 k) | 262 µs | 26 µs | 68 µs (4.2 µs/eval) | 225 µs (3.5 µs/eval) | 927 µs (3.6 µs/eval) |
  | 1024-512-512-256-1 (919 k) | 1,199 µs | 205 µs | 324 µs (20 µs/eval) | 1,130 µs (18 µs/eval) | 3,846 µs (15 µs/eval) |

  — local benchmark `ortbench/bench.mjs` (path above); installing with `--onnxruntime-node-install=skip` worked on Node 22 with no build step
- Independent corroboration of the batching effect: a 2025 paper reports a PyTorch MLP at ~39.8 µs per sample at batch 1 versus ~1.6 µs per sample at batch 32 on one 3.8 GHz core; another study finds framework overhead dominates at small input sizes, giving near-constant latency regardless of model size. — [arXiv 2505.23615](https://arxiv.org/pdf/2505.23615); [The Framework Tax, arXiv 2302.06117](https://arxiv.org/pdf/2302.06117) (both via search summary)
- Batching leaf evaluations in MCTS is done with virtual loss, which supplies "the diversity of the leaves in a batch"; Cazenave's Batch MCTS keeps a transposition table of network outputs so repeated states are not re-evaluated. Lc0 developer notes say they gather batches of up to ~1,200 and that virtual loss alone does not prevent collisions (draft page). — [Cazenave, Batch MCTS, arXiv 2104.04278](https://arxiv.org/pdf/2104.04278); [Lc0 dev notes (draft)](https://draft.lczero.org/dev/lc2/batching)
- KataGo's self-play configs use game-thread counts far above the core count specifically so that neural-net queries from many concurrent games fill GPU batches. — [KataGo SelfplayTraining.md](https://github.com/lightvector/KataGo/blob/master/SelfplayTraining.md)
- The repo already has a learned evaluator in pure JS: `game/learn/model.js` implements a standardised logistic regression (`winProb`) loaded from `data/bot-model.json`, hot-reloaded by file mtime and blended with the hand-tuned score. — `/home/user/Ink/game/learn/model.js`

### Inferences
- At 21–26 µs per call a small MLP supports ~40,000 evaluations per second per thread at batch 1, while the engine can generate at most a few thousand positions per second per core. Inference is therefore not the bottleneck for an MLP-sized value net, and batching/virtual-loss machinery (designed for GPU-bound AlphaZero-style search) would add complexity without benefit. It only becomes relevant for a transformer-sized model.
- GPU in production is not worth it for this model class: on a Docker-on-home-PC deployment the CUDA provider needs a Linux x64 image with CUDA 12 libraries and GPU passthrough, DirectML is unavailable inside a Linux container (Windows-only per the README table), and per-call GPU overhead would exceed the 21 µs CPU cost. The consumer GPU is better spent on training in Python.
- Pure-JS inference is ~2.6x slower than ORT for the 41 k-parameter net and ~10x slower for the 197 k net in this naive form. It remains attractive up to roughly the small size because it has zero dependencies, runs identically in workers and the browser client, and one evaluation (55 µs) is still cheaper than one state clone. Card-game features are sparse, so an NNUE-style sparse first layer (add weight columns only for non-zero inputs) would cut the pure-JS cost substantially; I did not measure that.
- `onnxruntime-web` (WASM) only matters if the same model must run in the browser (e.g. a client-side coach); for the server, the native binding is strictly better.
- Each worker thread needs its own `InferenceSession`; set `intraOpNumThreads: 1` so that N search workers do not each spawn an N-thread ORT pool.

### Gaps
- No measurement of small transformers; published per-call latencies for sub-10 M-parameter transformers under onnxruntime-node were not found. Expect milliseconds rather than microseconds on CPU, but that is not sourced.
- Whether tfjs-node 4.22.0's native addon installs cleanly on Node 22 was not tested, and no official deprecation statement was found — only the absence of releases.
- GPU provider latency was not measured (no GPU in the sandbox).
- `onnxruntime-node` WebGPU provider on Linux is listed as experimental; no reliability reports were found.

## 4. Training pipeline when the environment is JavaScript and training is PyTorch

### Takeaway
The proven pattern for a non-Python engine is offline and file-based: engine-side workers play games and write training rows to disk; a separate Python process shuffles, trains and exports; a gatekeeper match decides promotion. KataGo runs exactly this loop with a C++ engine and `.npz` files. Step-by-step IPC (gym over websockets, as poke-env does for the Node-based Pokémon Showdown) is the slow path and is only needed for on-policy RL, which the strongest Pokémon agents avoided by training offline.

### Cited Findings
- KataGo's loop has five independent processes communicating only through directories: self-play engine (C++) writes game data; shuffler (Python) turns it into shuffled `.npz` files; trainer (Python/PyTorch) trains continuously and checkpoints; exporter converts checkpoints into the engine's format; an optional gatekeeper (C++) plays each new export against the current accepted model and moves it to `models/` or `rejectedmodels/`. Model names encode samples trained and data rows generated (`…-s<samples>-d<rows>`). Suggested compute split: roughly 4x to 40x more on self-play than on training; default batch size 256; at most 4 training samples consumed per new self-play row. — [KataGo SelfplayTraining.md](https://github.com/lightvector/KataGo/blob/master/SelfplayTraining.md)
- KataGo's gatekeeper criterion in the paper: a candidate must win at least 100 of 200 games against the current net (a 50% bar, i.e. a regression guard rather than proof of improvement). Leela Zero used a 55% win-rate gate and later loosened it to roughly "promote unless worse than −50 Elo"; ELF OpenGo used 55%. — [KataGo paper, arXiv 1902.10565](https://arxiv.org/pdf/1902.10565); [Leela Zero issue #78](https://github.com/gcp/leela-zero/issues/78); [lczero forum](https://groups.google.com/g/lczero/c/vRGdUUXVM5E/m/qMIqeuQsBwAJ) (via search summary)
- Pokémon Showdown is a Node.js engine. `poke-env` (Python ≥ 3.10) connects to a Showdown server over websockets (default `ws://localhost:8000/showdown/websocket`), exposes a Gymnasium interface, and recommends running your own local server for training; concurrency is managed with asyncio and a `max_concurrent_battles` setting. No battles-per-second figures are documented. — [poke-env docs](https://poke-env.readthedocs.io/)
- Metamon (RLC 2025) used a customised poke-env against a locally hosted Showdown server, but its main training signal was **offline**: ~475 k human battles reconstructed into ~950 k first-person trajectories (~38 M timesteps), later 3.5 M trajectories, plus up to ~5 M self-play trajectories generated in batches between training rounds. Models were 15 M / 50 M / 200 M-parameter transformers. — [Metamon paper, arXiv 2504.04395](https://arxiv.org/html/2504.04395v2)
- `ygo-agent` (Yu-Gi-Oh) took the opposite route: it wraps the C++ `ygopro-core` engine in EnvPool so that many environments step in a C++ thread pool behind one batched Python call. Its README says training "typically" needs 8x RTX 4090 and a 128-core CPU for a few days; a maintainer reports ~1,000 training steps/s on a laptop GTX 1650. — [ygo-agent](https://github.com/sbl1996/ygo-agent) (via search summary)
- EnvPool's motivation: on a 12-core laptop it ran 2.8x faster than Python-subprocess vectorised environments; on a 256-core server it reached 1 M Atari frames/s. — [EnvPool, arXiv 2206.10558](https://arxiv.org/pdf/2206.10558)
- Hearthstone: SabberStone is a C# simulator; one project drove it from Python in-process via Pythonnet to train with TensorFlow; RosettaStone is a C++17 re-implementation with a Python API. — [AlphaHearthstoneZero](https://github.com/SethKitchen/AlphaHearthstoneZero); [RosettaStone](https://github.com/utilForever/RosettaStone) (via search summary)
- A 2026 preprint reports LLM research agents building a full Hearthstone Battlegrounds simulator and a PPO policy that decides in 0.03 s; relevant here as evidence that the simulator-plus-small-policy pipeline, not per-move LLM calls, is what reached top ladder ratings. — [arXiv 2610.33845](https://arxiv.org/abs/2610.33845) (abstract only; unreviewed)
- **[measured here]** An ONNX model built in Python (onnx 1.23.2) loaded and ran in `onnxruntime-node` 1.31.1 with outputs matching an independent JS implementation to 1e-4, so the Python → ONNX → Node hand-off works with current versions. — local benchmark `ortbench/bench.mjs`

### Inferences
- Recommended shape for Ink, by analogy with KataGo: Node self-play workers (the arena already exists) append fixed-width float32 feature rows plus labels (final result, lore margin, chosen move index, search visit distribution) to binary shard files; a Python script memory-maps them with NumPy, trains, exports ONNX plus a small JSON manifest; a Node gatekeeper script runs the SPRT match from section 5 and atomically replaces the production model file. `model.js` already hot-reloads by mtime, which is the same mechanism.
- File format: raw little-endian float32 shards with a JSON sidecar (feature schema version, engine git hash, model version that generated the data) are the simplest thing both languages read without dependencies (`Float32Array` on one side, `np.memmap` on the other). NPZ needs a zip writer in JS; Parquet needs a heavy JS dependency; JSONL is 5–10x larger and slow to parse but fine for debugging. This is engineering judgement, not a sourced comparison.
- Keep feature extraction in exactly one place (JS), since it must run at inference time in Node anyway; training Python should consume the already-extracted vectors. Any feature change bumps a schema version stored in both the shard sidecar and the model manifest, and the loader refuses mismatches.
- A gym-over-IPC bridge (stdin/stdout or websocket per step) costs a process round trip per action; at Ink's ~7,500 actions/s per core the engine would be throttled by serialisation of an 88 KB state unless only compact observations cross the boundary. It is justified only for on-policy algorithms (PPO) where Python must choose every action. Search-generated or self-play data with a frozen policy does not need it.
- Training in JS is a dead end given the tfjs status in section 3; "training in JS" is realistic only for the existing logistic-regression/linear models.
- Scale check: at ~80 scripted games/s per core, 10 cores produce ~2.9 M games/hour with a scripted policy, but only ~1 game per ~40 s per core if both sides run the 450 ms search (≈94 actions per game implied by 7,500 actions/s ÷ 80 games/s). Search-labelled data is therefore the scarce resource: ~900 games/hour on 10 cores. Using a reduced search budget for data generation (as chess engines use short time controls for testing) is the obvious lever.
- Gating: use the same paired-game SPRT harness for promotion as for code changes, with a regression-guard bound (accept unless clearly worse) for routine retrains and a "must be better" bound for anything that adds inference cost.

### Gaps
- Not researched to a citable level: Screeps, Battlesnake, and lichess Fishnet (distributed analysis/generation). No sources were retrieved for these, so they are omitted rather than described from memory.
- No public throughput numbers for poke-env against a local Showdown server, so the cost of the websocket-gym approach is not quantified.
- No sourced comparison of NPZ/Parquet/JSONL/binary for self-play data; the format advice above is opinion.
- PyTorch's ONNX export path (`torch.onnx.export`) was not exercised here; the test model was built directly with the `onnx` helper API.

## 5. Evaluating strength rigorously in a high-variance game

### Takeaway
40–80 game A/B matches cannot see anything smaller than a very large effect: at 80 games the 95% interval is ±11 percentage points (about ±77 Elo), and a bot that is truly 55% will score 50% or worse about one time in five. Detecting 55% vs 50% takes roughly 600–1,100 games at fixed sample size, or about 550 on average with an SPRT. The chess-engine recipe transfers directly: paired games on identical deals with seats swapped, scored as pairs, stopped by SPRT, with periodic fixed-length gauntlets against frozen reference versions.

### Cited Findings
- Elo and win rate: expected score `E = 1/(1 + 10^(−Δ/400))`, so `Δ = 400·log10(E/(1−E))`. Likelihood of superiority from wins and losses: `LOS = Φ((W − L)/√(W + L))`. — [Chess Programming Wiki: Match Statistics](https://www.chessprogramming.org/Match_Statistics)
- SPRT as used in engine testing: test H0 (Elo difference = elo0) against H1 (= elo1), update a log-likelihood ratio after each game or pair, stop when it leaves `[log(β/(1−α)), log((1−β)/α)]`; with α = β = 0.05 the bounds are ±2.94. — [Chess Programming Wiki: Match Statistics](https://www.chessprogramming.org/Match_Statistics); [Engine testing guide](https://dannyhammer.github.io/engine-testing-guide/print.html)
- Fishtest treats each **pair** of games (same opening, colours reversed) as one observation with five outcomes (the "pentanomial" model), which it says is more accurate than win/draw/loss counting and "saves substantial testing resources"; the gap between the two models estimates how biased the openings are. It uses a generalised SPRT with bounds in "normalized Elo" so that expected test length depends only on the bounds. — [Fishtest Mathematics](https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html)
- Fishtest practice: two-stage testing (short time control first, long time control only if it passes), limit retries of one idea to about four or five, never use SPRT to estimate Elo, and remember that 95% error bars mean about 1 result in 20 is an outlier. — [Fishtest FAQ](https://github.com/official-stockfish/fishtest/wiki/Fishtest-faq)
- Suggested bounds for hobby engines: "gainer" `[0, 10]` Elo for weak engines or big expected gains, `[0, 5]` for stronger engines; "non-regression" `[−10, 0]` or `[−5, 0]` for refactors; α = β = 0.05; always run a baseline-versus-itself sanity check first; let tests run to their conclusion. Example fixed-length result: 3,008 games gave ±9.9 Elo at 95%. — [Engine testing guide](https://dannyhammer.github.io/engine-testing-guide/print.html)
- Rule of thumb from chess testers: 95% error ≈ `560/√N` Elo at a ~1/3 draw rate; general form `695·√(4·s·(1−s) − drawFraction)/√N`. With no draws (Lorcana) this is `695/√N` near 50%. — [TalkChess: margin of error](https://talkchess.com/viewtopic.php?p=484153) (forum post, via search summary)
- A Fishtest-style SPRT(0, 5) in normalized Elo takes about 42,000 games in the expected worst case — the price of resolving 5-Elo differences, far beyond a home PC's budget for a 450 ms bot. — [vdbergh/simul](https://github.com/vdbergh/simul) (via search summary)
- OpenBench exposes the same knobs (bounds `[lower, upper]`, confidence `[0.05, 0.05]`, workloads counted in game pairs) and offers fixed-game mode for Elo estimates. — [OpenBench wiki](https://github.com/AndyGrant/OpenBench/wiki/SPRT-and-Fixed%E2%80%90Game-Workloads)
- **[computed here]** Games needed at fixed sample size to distinguish a true win rate p from 50%, no draws, normal approximation `n = ((z_α·0.5 + z_β·√(p(1−p)))/(p−0.5))²`:

  | True win rate (Elo) | Two-sided 5%, power 80% | One-sided 5%, power 80% | One-sided 5%, power 95% |
  |---|---|---|---|
  | 52% (+14) | 4,904 | 3,863 | 6,759 |
  | 53% (+21) | 2,178 | 1,716 | 3,001 |
  | 55% (+35) | 783 | 617 | 1,077 |
  | 57.5% (+53) | 347 | 273 | 476 |
  | 60% (+70) | 194 | 153 | 266 |
  | 65% (+108) | 85 | 67 | 115 |

  95% confidence half-width at 50%: 40 games ±15.5 points (±111 Elo); 80 games ±11.0 (±77 Elo); 200 ±6.9; 400 ±4.9 (±34 Elo); 1,000 ±3.1 (±22 Elo); 2,000 ±2.2; 5,000 ±1.4 (±10 Elo). — `stats.mjs` (path above); Elo conversion from [Match Statistics](https://www.chessprogramming.org/Match_Statistics)
- **[computed here]** Simulated SPRT on independent win/loss games, α = β = 0.05 (4,000 runs each):

  | Hypotheses | True rate | Mean games | Median | 90th pct | Accepts "better" |
  |---|---|---|---|---|---|
  | 50% vs 55% | 50% | 543 | 428 | 1,040 | 4.8% |
  | 50% vs 55% | 52.5% | 906 | 690 | 1,888 | 49% |
  | 50% vs 55% | 55% | 549 | 434 | 1,076 | 95% |
  | 50% vs 55% | 60% | 199 | 181 | 320 | 100% |
  | 50% vs 60% | 60% | 138 | 110 | 270 | 95.5% |
  | 50% vs 52.5% | 52.5% | 2,135 | 1,718 | 4,086 | 95% |
  | 45% vs 50% (non-regression) | 50% | 542 | 432 | 1,066 | 95% |

  So SPRT needs about half the games of the equivalent fixed test (549 vs 1,077 for 55% at 5%/5%) and finishes in ~200 games when the change is a clear win. — `stats.mjs` (path above)
- **[computed here]** With 80-game matches, a truly 55% bot scores ≤ 40/80 in 21.6% of matches, and a truly equal bot scores ≥ 44/80 (≥ 55%) in 21.7%. Informal peeking is worse: checking a running one-sided 5% z-test every 20 games up to 400 and stopping at the first "significant" result gives a 20.8% false-positive rate on equal bots. — `stats.mjs` (path above)
- Variance reduction in imperfect-information games can be very large: AIVAT, which uses a value function as a control variate over chance events and known-strategy decisions, cut standard deviation by 85% in a human-vs-AI hold'em match — "44 times fewer games to draw the same statistical conclusion" — while staying unbiased even with a poor value estimate. — [AIVAT, arXiv 1612.06915](https://arxiv.org/pdf/1612.06915)
- Measuring against humans: Pokémon Showdown rates with Elo, Glicko-1 and GXE (estimated chance to beat a random ladder opponent). Metamon needed at least 400 ladder battles over 4–8 days per human evaluation and reports e.g. GXE 79.9%, Glicko-1 1761 ± 35 after 100+ battles; Foul Play only recorded GXE once the Glicko deviation fell below 50. — [Metamon paper](https://arxiv.org/html/2504.04395v2); [Foul Play write-up](https://pmariglia.github.io/posts/foul-play)
- Humans exploit known bots: PokéChamp's authors report that players who knew they faced the bot exploited its switching behaviour, and stress anonymity for ladder evaluation; Metamon's rating fell when the opponent pool changed during a tournament. — [PokéChamp paper](https://arxiv.org/html/2503.04094v1); [Metamon paper](https://arxiv.org/html/2504.04395v2)
- Metamon also tracks a "heuristic composite" (average win rate against six fixed heuristic opponents) across separate team sets (procedurally generated variety set, replay-derived set, hand-picked competitive set) — a ladder of fixed references evaluated on more than one deck pool. — [Metamon paper](https://arxiv.org/html/2504.04395v2)

### Inferences
- The current protocol (40–80 games, paired seeds, seat alternation, 12 decks) has the right structure but an order of magnitude too few games. A realistic house standard: SPRT on game pairs with H0 = 50%, H1 = 55% (≈ +35 Elo), α = β = 0.05, capped at ~2,000 games; plus a non-regression variant (H0 = 45%, H1 = 50%) for refactors and speedups. Anything that cannot pass that is too small to detect on this hardware at full budget and should be tested at a reduced budget or judged by other means.
- Throughput: with ~94 actions per game, a 450 ms search for most decisions is on the order of 40 s per game per core; 1,000 games ≈ 11–12 core-hours, i.e. roughly 1–1.5 hours on 8–12 workers. A "short time control" stage (e.g. 100 ms or a fixed sample count per decision) runs ~4x faster and mirrors Fishtest's two-stage approach. A fixed-sample-count budget also makes results independent of machine load, which matters on a PC that is also serving the site.
- Pairing: one unit = one seed (identical shuffles and deck pairing) played twice with the bots swapping seats and decks; score the pair as 0, 1 or 2 wins for the candidate. Pairs where both games go the same way regardless of bot (decided by the deal or the first-player advantage) cancel exactly; only split pairs carry signal. The required number of pairs scales with (1 − ρ), where ρ is the correlation of the two bots' results on the same deal. ρ should be estimated from existing arena logs before choosing sample sizes; the gap between pair-based and game-based variance also measures how deal-dominated the game is (the Fishtest "book bias" idea).
- Common random numbers only help if they stay common: the search bot draws from `Math.random()`, and the engine RNG stream will desynchronise once the two bots make different choices that consume randomness. Seeding the bot's own RNG separately from the engine's, and deriving shuffle order from a per-game deck permutation fixed at setup, would raise ρ.
- Deck coverage: 12 decks give 144 ordered pairings; one seat-swapped pair on each is 288 games per full pass. Stratify so each SPRT batch covers the matrix evenly, and report the 12x12 win-rate matrix alongside the pooled number so that an average gain hiding a collapse in one matchup is visible.
- Overfitting to seeds and decks: keep a development seed range and a held-out range, draw fresh seeds for every confirmation run, and hold out a few decklists (or use a second pool such as the previous set's meta) that are never used for tuning — the equivalent of Metamon's separate team sets.
- Reference ladder: freeze every promoted version plus two or three fixed reference bots (scripted bot, search at 1/4 budget, search at 4x budget). Run a round-robin occasionally and fit Elo to the whole table; this detects non-transitive "beats the previous version only" progress, and the budget-scaled references give a physical meaning to each Elo step. BayesElo and Ordo are the usual tools for fitting ratings from a results table; a logistic-regression fit over the pairings is an adequate custom substitute.
- What a small custom "Fishtest" needs: (1) a match runner that takes two bot configurations, a deck-pair list and a seed range and emits one JSON line per game (seed, decks, seats, winner, turns, per-decision time, engine git hash); (2) pair-level scoring and an SPRT stop rule; (3) resumability and a results database (SQLite is already in use); (4) a self-test where A = B must come out at ~50% and pass SPRT only ~5% of the time; (5) CPU pinning or sample-count budgets so time-based search is not distorted by parallel load.
- An AIVAT-style control variate is feasible later: once there is a calibrated value model, subtracting the model's estimate of "luck" (value change at chance events such as draws) from each game result gives an unbiased, lower-variance outcome. The poker result suggests large savings, but it depends on evaluator quality and has not been demonstrated for a trading card game.
- Human-facing measurement: log bot-versus-human results with bot version, budget and deck; use a rating system with an uncertainty term (Glicko-style) for both sides; do not trust a version's rating until its deviation is small (Foul Play's threshold was 50) or it has several hundred games (Metamon needed 400+). With a small friendly player base, human data is better used for blunder mining (section 6) than for A/B decisions.
- Exploitability proxies when a true best-response is infeasible: (a) win rate of a much-higher-budget search against the bot; (b) a trained or tuned "exploiter" that only plays against the frozen bot; (c) win rate against deliberately odd strategies (all-in aggro, pure control, never-quest) to catch systematic holes; (d) human players who know it is a bot. These are standard practice by analogy; no card-game-specific source quantifying them was found.

### Gaps
- No source quantified the variance reduction from seed pairing or duplicate deals in a trading card game; the size of ρ for Ink is unknown until measured.
- The Fishtest pages retrieved do not state their standard bounds or typical game counts; the 42,000-game figure comes from a search summary of a simulator README.
- AlphaGo Zero's "400 games, 55%" evaluator rule could not be confirmed from a primary source in this session.
- BayesElo and Ordo were not looked up; they are named from general knowledge only.
- No published first-player-advantage-aware rating method for card games was found; pairing with seat swap is the standard remedy and is what the chess tools do for colour.

## 6. Diagnostics: finding out why a bot is weak

### Takeaway
The most informative single experiment is budget scaling: play the bot against itself at 1x vs 4x thinking time. A healthy search gains tens of Elo per doubling (about 57 in the Chaslot data); a flat curve means the evaluation or the move generation, not the search volume, is the limit. Test-position suites are useful as regression guards and for locating blind spots, but chess practice is unanimous that they do not measure strength.

### Cited Findings
- Budget-scaling template: Mango's win rate against a fixed opponent rose from 26.7% at 1 s to 56.5% at 16 s per move, fitting 56.7 Elo per doubling with R² = 0.99 over 2,000 games per setting; the authors then express every parallelisation method as an equivalent time multiplier. — [Chaslot et al. 2008](https://dke.maastrichtuniversity.nl/m.winands/documents/multithreadedMCTS2.pdf)
- The Chess Programming Wiki keeps tables of Elo gain from doubling the time control as a standard reference measurement. — [Match Statistics](https://www.chessprogramming.org/Match_Statistics)
- Test positions: "useful to prove whether things are broken after program changes or to get hints about missing knowledge. But one should be careful to tune engines based on test-position results." Practitioners report suites where the solved count went down while the engine got stronger, positions with more than one valid answer, and pruning changes that raised self-play Elo while badly hurting a tactical suite. — [Chess Programming Wiki (test positions)](https://www.chessprogramming.org/Special:MobileDiff/1620); [TalkChess thread on WAC](https://talkchess.com/viewtopic.php?p=947255) (via search summary)
- PokéChamp's authors diagnose by component accuracy: top-1 agreement of the model's action prediction with human players' moves was 26–30% for the acting player and 13–16% for the opponent, and they separately scored 1v1 "puzzle" endgames (86% solved vs 76% for the previous agent). They also split results by cause of loss: about one third of ladder games were lost on time; in the rest the win rate was 76%. — [PokéChamp paper](https://arxiv.org/html/2503.04094v1)
- The mage-bench (Magic: The Gathering) author had a strong model review every decision after each game to produce a "blunder index", and found it flagged many non-blunders and that most notable "blunders" were harness or tooling faults rather than strategy errors. — [Show HN: mage-bench](https://hn.svelte.dev/item/47049227)
- Foul Play's author observes the bot is strongest where the opponent's hidden information is most predictable (random formats with fewer than a dozen possible sets per Pokémon), i.e. hidden-information inference quality, not search depth, limits it in open formats. — [Foul Play write-up](https://pmariglia.github.io/posts/foul-play)
- The search function in the repo already accepts an `extra` move "to make sure is among the candidates (analysis of a move someone actually played)", which is the hook needed for comparing a played move against the search's choice. — `/home/user/Ink/game/searchbot.js` (around line 254)

### Inferences
- A diagnostic ladder for Ink, in order of cost:
  1. **Budget scaling**: same bot at 0.25x, 1x, 4x, 16x budget in a round-robin (16x can run offline). Read the slope. Flat from 1x to 4x means more speed (sections 1–2) will not help and effort should go to evaluation, determinization quality or move generation. Steep means the speed work is worth real Elo.
  2. **Ablations with the SPRT harness**: switch off one component at a time (learned-model blend, opponent-hand inference, a rollout policy heuristic) and measure the loss; components that cost nothing to remove are dead weight or bugs.
  3. **Shallow-versus-deep disagreement mining**: on logged positions, compare the 450 ms choice with a 30–60 s choice. Positions where they differ and the deep search's value gap is large are candidate blunders; cluster them by action type (ink choice, quest vs challenge, mulligan, target selection) to see where budget is being lost. This is the card-game analogue of comparing against a deeper engine line.
  4. **Blunder mining from human games**: when a human beats the bot, re-search the bot's decisions at high budget with the full information revealed after the game; decisions that look bad even with true hidden information are evaluation errors, and those that only look bad in hindsight are variance.
  5. **Position suite**: collect 100–300 positions with a clearly correct action (lethal available, forced defensive play, obvious ink choice) from the above and run them as a fast regression check (seconds, no games). Use it as a guard, never as a tuning target, per the chess experience.
  6. **Value calibration**: bucket the evaluator's predicted win probability at turns 2, 4, 6, 8 and plot against actual outcomes over a few thousand self-play games (reliability diagram), separately for first and second player. A value model that ignores the first-player effect or is overconfident early will show up immediately; a Brier score or log-loss per turn gives one number to track.
  7. **Time and failure accounting**: fraction of decisions hitting the minimum sample count, samples per decision by game phase, and fraction of games decided by fallback moves — the PokéChamp result shows operational losses can dwarf strategic ones.
- Because search uses `Math.random()`, a "why did it do that" replay is not reproducible today; seeding the bot RNG and logging the seed per decision is a prerequisite for most of the above.

### Gaps
- No source describes a puzzle or EPD-style suite for a trading card game with hidden information; the suite design above is by analogy with chess.
- No published reliability-diagram results for card-game value networks were retrieved.
- I did not find quantitative guidance on how large a shallow-vs-deep disagreement must be to count as a blunder when both searches are noisy; this needs an empirical noise floor (run the deep search twice and measure self-disagreement).

## 7. LLM-based players (2023–2026)

### Takeaway
As per-move players, LLMs are weaker, slower and far more expensive than specialised search or RL agents in every card-like domain with a published head-to-head, and they lose games to time limits. The evidence favours using LLMs around the bot — building tools, writing heuristics and code, reading card text into structured features, explaining moves — rather than inside the decision loop.

### Cited Findings
- NeurIPS 2025 PokéAgent Challenge (100+ teams): "In battling, the top participants all used RL or MCTS rather than LLM reasoning" and "specialist RL agents far outpace harness LLM agents in competitive battles." 13 of 16 qualifying spots went to teams extending the RL baselines; the Gen 9 OU winner was Foul Play, a root-parallel MCTS bot with a hand-written evaluation. Default 60–90 s turn timers were insufficient for LLM inference, so an extended-timer ladder was created; weaker models showed "panic behaviour", compounding errors. — [PokéAgent Challenge paper, arXiv 2603.15563](https://arxiv.org/html/2603.15563)
- Cost per game for LLM agents on that ladder (about 18–24 turns per game, ~1,200–2,500 input tokens per turn): GPT-5.2 $1.25; Claude Opus 4.6 $0.34; Claude Sonnet 4.6 $0.21; MiniMax M2.5 $0.12; Gemini 3.1 Pro $0.066; Gemini 3 Flash $0.020; DeepSeek V3 $0.017; Qwen3.5 Plus $0.014 — a 70x spread driven by output pricing and reasoning verbosity. Gemini 3 Flash reached 71% GXE with direct prompting; a 1 B-parameter Gemma model rose from 29% to 53% GXE when wrapped in the PokéChamp search harness. — [PokéAgent Challenge paper, Appendix F](https://arxiv.org/html/2603.15563)
- PokéChamp (ICML 2025) puts an LLM inside a depth-limited minimax as action proposer, opponent model and leaf evaluator, with a damage calculator as a tool. With GPT-4o it beat the best prior LLM bot 76% and the strongest rule-based bot 84%; offline Elo 1268 vs 1117 for the rule-based bot; projected 1300–1500 on the human ladder. About one third of its ladder games were lost on time. It is weak against stalling and heavy switching. — [PokéChamp paper](https://arxiv.org/html/2503.04094v1)
- Metamon (offline RL transformers, no LLM) reached the top 10% of active human players in early generations, beat or tied Foul Play, and reports that the GPT-4o-based PokéLLMon "struggles with long-term planning". Released checkpoints range from small RNNs to 200 M parameters; later checkpoints reached 64–82% GXE across generations. — [Metamon paper](https://arxiv.org/html/2504.04395v2); [PokéAgent Challenge paper](https://arxiv.org/html/2603.15563)
- Hearthstone (AAMAS 2025 extended abstract; table read directly): against tree-search AIs of increasing strength, direct-prompted GPT-4o won 60% / 24% / 12%, the RL baseline Cardsformer 82% / 68% / 48%, and an RL agent using a fine-tuned T5 encoder for card text 96% / 76% / 68%. The authors conclude "LLMs alone struggle with competitive Hearthstone strategies"; the language model's useful role was encoding card text so the policy generalises to unseen cards. — [Xia et al., AAMAS 2025](https://aamas.csc.liv.ac.uk/Proceedings/aamas2025/pdfs/p2795.pdf)
- Hearthstone Battlegrounds (preprint, October 2026): LLM research agents built a simulator and trained a PPO policy over 20 days; the policy climbed the live ladder from 6,000 to about 15,000 rating. On a 960-task benchmark the policy solved 91% of play tasks in 0.03 s per decision; frontier LLMs solved at most 63% and took up to 26 s, and within the live turn timer no LLM exceeded 26% accuracy. The authors' conclusion: "LLM agents build far better than they play." — [arXiv 2610.33845](https://arxiv.org/abs/2610.33845) (abstract only; unreviewed)
- Magic: The Gathering via XMage and MCP tools (mage-bench, 2026): the author reports "a dollar or more" per game, frequent hallucinated card effects and confused mana costs, the need to inject Oracle text for visible cards, and judges that LLMs are "probably not good enough to outperform even very basic decision-tree AIs today". A former competitive player reviewing games found basic strategic concepts missing. — [Show HN: mage-bench](https://hn.svelte.dev/item/47049227)
- Imperfect-information reasoning: Suspicion-Agent (GPT-4 with theory-of-mind prompting) was evaluated quantitatively only on Leduc Hold'em, a toy game; its claim weakened between versions from outperforming CFR and NFSP to outperforming "some of" the baselines (CFR+, NFSP). — [Suspicion-Agent, arXiv 2309.17277](https://arxiv.org/abs/2309.17277v3)
- Cicero (Diplomacy, Science 2022) is the canonical hybrid: a 2.7 B-parameter language model handles dialogue while a separate self-play-trained planning module chooses moves; it scored more than twice the human average over 40 online games. Strategy came from the planner, not the language model. — [Cicero, Science 2022](https://pubmed.ncbi.nlm.nih.gov/36413172/); [Meta AI](https://ai.meta.com/research/cicero/)
- Benchmarks exist but mostly rank LLMs against each other, not against search: TextArena (74 text games, online rating with a collective "Humanity" entry) and BalatroBench (average round reached on fixed seeds, three plays per seed, with tool-call validity, tokens, time and cost tracked per model). — [TextArena, arXiv 2504.11442](https://arxiv.org/html/2504.11442v2); [BalatroBench](https://coder.github.io/balatrobench/about.html)

### Inferences
- For Ink, a per-move LLM player is not viable on any axis that matters: the bot must answer in 450 ms on a home PC, while LLM turns take seconds to tens of seconds; hosted models would cost cents to a dollar per game; and the published strength is below ordinary search. A local small model does not fix this — the Gemma 1 B result shows the search harness, not the model, supplies most of the strength.
- Sensible hybrid uses, ranked by evidence:
  1. **LLM as builder**: writing evaluation features, heuristics, card-specific rules and test positions offline, verified by the SPRT harness. This is the Battlegrounds preprint's finding and matches how this project already works.
  2. **Card-text understanding**: generating structured tags or embeddings per card (removal, ramp, draw, evasive, lore pressure) once per set, cached as static features. The Hearthstone T5 result is direct evidence this helps generalisation to new cards; it costs nothing at decision time.
  3. **Explanation layer for a coach**: the engine decides and quantifies; an LLM turns "search preferred A over B by 6 points of win probability, main line …" into prose. This is the Cicero split (language model talks, planner plays). It can be asynchronous and rate-limited.
  4. **Deck-level and mulligan priors**: low-frequency decisions where seconds of latency are tolerable; but a mulligan table learned from self-play is cheaper and testable, so the LLM is best used to propose candidates that are then measured.
  5. **Leaf evaluation or move proposal inside search** (the PokéChamp design): only if a very small local model can answer in under ~10 ms, which no cited result demonstrates.
- Any LLM-derived heuristic should go through the same paired SPRT as hand-written ones; the mage-bench experience (an LLM reviewer flagging non-blunders) is a warning against using an LLM as the judge of play quality.

### Gaps
- No published LLM agent or benchmark for Disney Lorcana was found.
- No Slay the Spire LLM paper was retrieved; BalatroBench's per-model scores and costs were not retrievable; the MTG Bench (no-rules-engine) win rates could not be confirmed.
- PokéChamp and the PokéAgent paper do not report per-turn latency in seconds, only timer settings and time-outs.
- Model names and prices in the cost table are as reported by the PokéAgent paper in early 2026 and will have changed.
- GameBench-type strategic reasoning benchmarks were not researched to a citable level.

## 8. Commentary and coach features from a noisy evaluation with hidden information

### Takeaway
Both major chess sites classify moves by loss of win probability, not raw evaluation, and publish the thresholds (chess.com: 5 / 10 / 20 points of expected score for inaccuracy / mistake / blunder). That framing transfers to a card game, but only if the coach's verdicts are restricted to differences larger than the evaluator's own noise and are computed from the information the player actually had.

### Cited Findings
- chess.com classifies each move by expected points lost (scale 0–1 win expectancy): Best 0.00; Excellent 0.00–0.02; Good 0.02–0.05; Inaccuracy 0.05–0.10; Mistake 0.10–0.20; Blunder 0.20–1.00. Expected points are computed from the engine evaluation **and the player's rating**. "Great" = a move critical to the outcome (e.g. the only good move); "Miss" = failing to punish an opponent's mistake; "Brilliant" = a sound piece sacrifice, judged more generously for newer players. — [chess.com: How are moves classified?](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc)
- chess.com's accuracy score (CAPS2) was redesigned so that typical games score between about 50 and 95 rather than clustering near 99. — [chess.com: accuracy](https://support.chess.com/en/articles/8708970-how-is-accuracy-in-analysis) (via search summary)
- Lichess converts centipawns to win percentage with a logistic curve (constant 0.00368208, fitted to real game data), then maps each move's drop in win percentage to accuracy with `103.1668·exp(−0.04354·ΔWin%) − 3.1669`; game accuracy combines a volatility-weighted mean with a harmonic mean rather than a plain average. — [Lichess accuracy page](https://lichess.org/page/accuracy) (via search summary; page returned 403 to direct fetch)
- An automated reviewer can mislead: mage-bench's LLM-generated blunder index "flags many non-blunders", and commenters stress that with hidden information and high variance many games are needed before judging decisions by outcomes. — [Show HN: mage-bench](https://hn.svelte.dev/item/47049227)
- Humans adapt to and exploit known bot habits (PokéChamp's switching), which bears on whether a coach should reveal the bot's reasoning in live play. — [PokéChamp paper](https://arxiv.org/html/2503.04094v1)
- The repo's search already keeps per-move sample count, sum and sum of squares (`stats = moves.map(() => ({ n: 0, sum: 0, sq: 0 }))`), which is exactly what is needed to attach a standard error to each move's value. — `/home/user/Ink/game/searchbot.js` (around line 262)

### Inferences
- Use the chess.com unit (points of win probability lost) rather than raw score, and require calibration first: the thresholds only mean something if a predicted 60% really wins about 60% (section 6, calibration plot).
- Classify only when the gap is statistically real. With per-move mean and variance over determinization samples, compute the difference between the played move and the best move on the **same** samples (paired), and label a move only if the gap exceeds both a threshold and about two standard errors. Otherwise say "close call". The chess.com cut-offs (5/10/20 points) are a reasonable starting scale, but the minimum reportable gap must be set from the measured noise floor at the analysis budget.
- Judge decisions from the player's information set: evaluate the played move against alternatives averaged over hands consistent with what the player could know, never against the opponent's actual hidden hand. A separate "with hindsight" view can be offered explicitly, but grading on revealed information punishes correct plays that lost to an unlikely card.
- Analysis is offline, so it can use 10–100x the live budget; this narrows the noise and makes the coach strictly stronger than the opponent bot the player just faced.
- Prefer a few high-confidence moments per game ("three turning points") over a per-move accuracy percentage. A single accuracy number invites comparison with chess figures while resting on a far noisier evaluator; if one is shown, average only over decisions with a confident gap and present it as approximate.
- Separate luck from skill in the summary: reporting the change in win probability at chance events (draws, shuffles) next to the change at decisions tells the player how much of the result was variance — the same decomposition AIVAT uses for evaluation.
- Rating-dependent expectations (chess.com) have a card-game analogue: for newer players, flag only large, simple errors (missed lethal, skipped ink, failed to quest for the win), and reserve fine sequencing criticism for experienced players.
- An LLM is appropriate for wording the explanation from structured engine output, not for deciding what was a mistake.

### Gaps
- No published methodology for move classification or accuracy scoring in an imperfect-information card game was found; everything above the chess facts is design reasoning.
- chess.com does not publish how expected points depend on rating; the exact Lichess aggregation weights were not retrieved.
- No user research was found on how players respond to noisy or probabilistic coaching verdicts in card games.
