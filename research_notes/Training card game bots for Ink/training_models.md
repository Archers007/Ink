# Training models to play collectible card games (methods, representations, recipes, data and compute)

Source-status tags used below: **[PR]** peer-reviewed paper, **[pre]** arXiv preprint / not confirmed peer-reviewed, **[thesis]**, **[repo]** project README or model card, **[blog]** blog, press report or talk recap. "Snippet only" means the fact comes from a search-result summary; the page itself was not read in full.

No published or hobby work on a learned Lorcana agent was found (one targeted search; results were all about other games).

---

## 1. Value-function learning for search: targets, why weak-policy outcomes fail, Expert Iteration loops, cheap evaluators

### Takeaway
A value net learned from game outcomes estimates the value *of the policy that generated the games*; the fix that every strong search-based system uses is a loop in which the current net drives the search, the search generates the next data, and the net is retrained (64 such iterations lifted a Hearthstone MCTS bot from 26.5% to about 50–56% as second player with only a 256-128-64 MLP). Small evaluators (logistic regression, GBDT, 3-layer MLPs) are well supported by card-game evidence; NNUE-style nets have no card-game precedent.

### Cited Findings
- **Expert Iteration (ExIt) loop**: (1) self-play by the apprentice net generates states; (2) the expert (tree search guided by the apprentice) labels them; (3) a new apprentice is trained by imitation; (4) the expert is rebuilt on the new apprentice. Value targets in ExIt are Monte Carlo game outcomes *of the apprentice's own play* (the authors say estimating the expert's value was too expensive), trained with cross-entropy alongside the policy loss in one multitask net. Only one position is sampled per game "to avoid correlated training data". [PR, NeurIPS 2017] — [Anthony, Tian & Barber 2017](https://arxiv.org/abs/1705.08439)
- ExIt policy targets: training on the root visit distribution ("tree-policy targets") gave a net about 50 ± 13 Elo stronger than training on the single chosen move, despite near-identical prediction error. Keeping a growing/rolling dataset (online ExIt, DAgger-style) "substantially outperformed" retraining on fresh data only. ExIt learned stronger policies faster than REINFORCE policy-gradient self-play started from the same net (figure only, no Elo table). [PR] — [Anthony et al. 2017](https://arxiv.org/abs/1705.08439)
- **Hearthstone value net + MCTS, iterated** (Świechowski, Tajmajer, Janusz 2018): input vector of 750 numbers (hero HP/mana/weapon, per-minion attributes, hand card type/cost, turn number, deck count) plus 10-dimensional word2vec embeddings of card text; fully connected 256-128-64 tanh net with a 2-way softmax winner output. Seeded with 20,000+ games of plain MCTS; then 64 iterations of 3,000 games each, sampling state–outcome pairs with p = 0.5, FIFO dataset capped at 1M samples, net retrained from scratch each iteration. The net is used to cut rollouts short (rollout stops at end of turn, not before step 20, then the net's win probability is backed up) rather than to replace simulation entirely. [pre; the text calls itself a non-final version] — [Świechowski et al. 2018](https://arxiv.org/abs/1808.04794)
- Measured effect in that work: as second player with CubeWarlock vs plain MCTS ZooWarlock at 0.5 s/move, plain MCTS won 26.5%; value net only 50.2% (55.9% at 1 s); value net + hand-written attack "board solver" 56.1%. Against humans (small samples): roughly even vs regular-rank players, 43% (as P2) and 17% (as P1) vs Legend players. Per-deck, per-seat networks were more accurate than general ones; validation accuracy of winner prediction was about 0.76–0.79. [pre] — [Świechowski et al. 2018](https://arxiv.org/abs/1808.04794)
- **Outcome prediction from weak-policy data** (AAIA'17 Hearthstone challenge): 3.25M training states from ~65,000 games between random-move agents; top ensemble (CNNs) AUC 0.8019; a 2-hidden-layer fully connected baseline 0.7846; XGBoost popular and "simpler logistic regression models also performed well". A model trained on random-play data dropped only from ~0.79 to ~0.75 AUC on MCTS-agent games. Test set used 27 decks vs 9 in training (unseen cards). [PR, FedCSIS 2017] — [Janusz et al. 2017](https://arxiv.org/abs/1708.00730)
- **Monte Carlo return vs TD bootstrapping** in a sparse-reward card game: DouZero regresses Q(s,a) on the final game return with no bootstrapping; replacing it with a TD (SARSA) target gave "no clear benefit" and learned slightly slower; the authors argue bootstrapped Q-learning suffers over-estimation with large, variable action sets. [PR, ICML 2021] — [Zha et al. 2021](https://arxiv.org/abs/2106.06135)
- **Discount**: ByteRL found γ = 1.0 instead of 0.99 raised win rate about 7 points in Hearthstone (episodes of ~100 steps, ±1 reward only at the end). [PR, IEEE CoG 2023 per arXiv comment] — [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- **Game outcome z vs search value q as the value target**: an Oracle engineering write-up reports that training on root Q can beat training on Z in short games (Connect Four) and that averaging the two combines Z's resistance to the horizon effect with Q's lower noise; the Lc0 team likewise suggested the q/z average to avoid a feedback loop toward "nonsensical values". [blog; snippet only, pages not read] — [Oracle "Lessons from AlphaZero" part 4](https://medium.com/oracledevs/lessons-from-alphazero-part-4-improving-the-training-target-6efba2e71628); [Lc0 blog 2018](https://blog.lczero.org/2018/10/understanding-training-against-q-as.html)
- **Value net with 1-ply lookahead and no MCTS**: a 2026 preprint finds self-play Approximate Value Iteration learns *more accurate* value functions than AlphaZero on Connect Four and 7×7 Hex, and its one-step-lookahead greedy policy is competitive with MCTS policies at "substantially lower training and inference costs" (abstract only; no numbers read). [pre] — [Boige, Boumaza & Scherrer 2026](https://arxiv.org/abs/2609.09094)
- **Search on top of a strong policy net has diminishing returns**: ByteRL tried MCTS at inference in LOCM; it won 56% vs the raw net after 40 h of training, 52% at 80 h, 51% at 144 h, and was dropped. [pre] — [Xi et al. 2023](https://arxiv.org/abs/2303.04096)
- **NNUE**: introduced for shogi in 2018, later chess; used for leaf evaluation in alpha-beta on perfect-information board games; speed comes from incremental updates of the first layer. A search found no card-game application. [reference; snippet only] — [Wikipedia: Efficiently updatable neural network](https://en.wikipedia.org/wiki/Efficiently_updatable_neural_network)
- LOCM competition history: before 2022 the winners were shallow search (minimax depth ≤3, best-first, depth-limited MCTS) with hand-tuned or evolved/Bayesian-optimised heuristic evaluations; a hand-prediction add-on (ProphetCoac) *reduced* win rate, "most likely due to less time available for search". [pre] — [Kowalski & Miernik 2023](https://arxiv.org/abs/2305.11814)

### Inferences
- The current Ink evaluator fails for the reason ExIt identifies: it is a (correct) estimate of "who wins if both sides keep playing like the weak scripted bot", so it cannot credit anything the scripted bot never converts (tempo, card advantage, removal timing). The AAIA result shows such a model is still a usable *starting* evaluator (AUC transfer 0.79 → 0.75); the Świechowski loop shows the gain comes from regenerating data with the search-plus-net player.
- For Ink the nearest proven recipe is Świechowski's: outcome target, small MLP, positions subsampled per game, rolling buffer of ~1M positions, tens of iterations of a few thousand search-vs-search games. Blending the search root value into the target (q/z average) is a plausible refinement but its support here is blog-level.
- With ±1 terminal reward and games of bounded length, undiscounted Monte Carlo targets are the safe default; TD(λ)/TD-leaf have no card-game evidence in what was found.

### Gaps
- No source found comparing TD(λ) or TD-leaf against outcome targets in a CCG.
- No measured card-game result for gradient-boosted trees *inside a search* (only for offline win prediction) and none for NNUE-like incremental nets.
- The Oracle and Lc0 posts could not be fetched (HTTP 403 / not attempted); their numbers are unverified.

---

## 2. Policy learning: what has been applied to CCGs, with what results and compute

### Takeaway
The only CCG agents shown to beat strong humans (ByteRL in Hearthstone) or to win competitions (ByteRL in LOCM) are model-free self-play actor-critic agents trained on thousands of CPU cores; at hobby scale the documented successes are small PPO/DMC agents on fixed decks and search-plus-learned-evaluator hybrids, and pure behaviour cloning of a search bot has repeatedly plateaued below its teacher.

### Cited Findings
- **ByteRL, Legends of Code and Magic** (Xi et al. 2023): one end-to-end network for draft and battle, trained from scratch by policy gradient (V-trace + UPGO losses, entropy 0.01, lr 5e-5, γ 0.99, LSTM 256) with "optimistic smooth fictitious play": self-play with probability 0.6, otherwise a historical checkpoint sampled by win statistics; the learner is added to the pool when it beats every member at >70%. Compute: one "unit" = 1 V100 GPU + 600 CPU cores; LOCM 1.5 model used 24 units for ~72 h at ~500K frames/s; LOCM 1.2 used 1 unit for 3 days then 8 units for 6 days. Won both COG 2022 tracks (organiser figures 84.41% and 94.56% average win rate). [pre; competition result confirmed in Kowalski & Miernik] — [Xi et al. 2023](https://arxiv.org/abs/2303.04096); [Kowalski & Miernik 2023](https://arxiv.org/abs/2305.11814)
- COG 2022 LOCM table: ByteRL 84.41%, NeteaseOPD 75.00%, Inspirai 67.57%; four of six entries used neural networks, two of them PPO. [pre] — [Kowalski & Miernik 2023](https://arxiv.org/abs/2305.11814)
- **ByteRL, Hearthstone** (Xiao et al. 2023): environment built on Hearthbreaker, 3 heroes, 350+ cards, rules of April 2015; agent does deck building and battle. Best non-cheating model "b4" trained 23 days on 24 V100 GPUs and 5,856 CPU cores (baselines used 8 GPUs, batch 1e4 × 8, lr 7e-5). It beat a streamer whose best rank was top 10 in China's official league in two Bo5 matches 3:0 and 3:0; a deck-peeking variant won 3:1 and 3:2. Stepwise gains reported: γ 1.0 (+7 points), V-trace/off-policy fixes incl. FIFO queue instead of ring buffer (+15.1), one model per hero (+6.5), asymmetric peeking at the opponent's deck (+5.5). Doubling/tripling batch/GPUs without growing the net did not help. [PR, CoG 2023] — [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- **ByteRL is exploitable by a tiny net** (Haluška & Schmid 2024): a 2-hidden-layer MLP (256, 128) cloned from 110,000 ByteRL self-play matches (~2.3M state–action pairs after removing pass actions) won 42.4% vs ByteRL; PPO fine-tuning against ByteRL then reached 90.4% on 32 fixed deck pools, 80.1% on 256, 54.2% on 1,024 (without BC pretraining: 81.2%, 72.0%, 41.8%). Filtering pass actions was worth almost 7 points of BC strength; wider/deeper nets overfit. Battle stage only; compute not reported. [PR workshop, ALA 2024] — [Haluška & Schmid 2024](https://arxiv.org/abs/2404.16689)
- **Hearthstone search + learned rollout policy** (Zhang & Buro 2017): CNN "card-play" policy trained on 27,000 open-hand games per mirror matchup generated by determinized UCT with 10,000 rollouts/move; used once per turn as a high-level rollout policy. Added to DUCT + Silverfish evaluation + chance-node bucketing it won 57.2% combined (53.4–62.6% by deck) against the same searcher without it at 10 s/move; the base DUCT searcher itself won 60.1% vs Silverfish at 5 s/move. [PR, IEEE CIG 2017] — [Zhang & Buro 2017](https://skatgame.net/mburo/ps/cig17-hsai.pdf)
- **Yu-Gi-Oh ygo-agent** (sbl1996): deep RL in JAX (PPO-style scripts `ppo.py` / `cleanba.py`), LSTM added April 2024. README: trainable on a laptop GTX 1650 at ~1,000 steps/s; a 204,800-step run (≈3 min) reaches 98% vs random on one deck, but wins only 3.1% of 128 games against the released checkpoint, which was trained on "over 100M games" ("equivalent to 32 4090 GPUs for 5 days"; elsewhere "typically 8x4090 GPUs and 128-core CPU for a few days"). No human-benchmark numbers; MCTS, league training and zero-shot new cards are listed as future work. [repo] — [sbl1996/ygo-agent](https://github.com/sbl1996/ygo-agent)
- **Pokémon TCG Pocket production AI** (DeNA, CEDEC 2026 talk by Kosuke Sakimi, as reported by Inven Global): ~2M-parameter stateless transformer; built on the open-source HandyRL library (off-policy, distributed); 50 million episodes per model on six 32-vCPU machines; game has ~3,500 cards; agent plays ~540 predefined decks plus user decks. No win rates vs humans reported. [blog/press] — [Inven Global 2026](https://www.invenglobal.com/articles/24133/how-reinforcement-learning-ai-tackles-the-complex-rules-of-pok%C3%A9mon-trading-card-game-pocket)
- **Pokémon TCG hobby agents** (pkm-cabt-ppo): PPO self-play with a checkpoint-pool of opponents, ~0.5M-parameter pointer-style net; one variant distils IS-MCTS (determinized) targets back into the net (expert iteration). Results only vs a random agent (80–100% on ≤20 games); agents are deck-specific. [repo] — [TomatoCream/pkm-cabt-ppo](https://huggingface.co/TomatoCream/pkm-cabt-ppo)
- **Legends of Runeterra** (Riot, talk by Ben Kasper recapped by Anyscale, 2022): RL agent trained first on 1 deck, later 10; reached a 48% win rate against top human players; used for pre-release balance testing. Algorithm, network and compute are not given in the recap. [blog] — [Anyscale 2022](https://www.anyscale.com/blog/riot-games-and-deep-reinforcement-learning-in-gaming)
- **Magic: The Gathering**: a 2026 benchmark (MTG-Causal-RL) offers five Standard archetypes, a 3,077-dim observation and 478 masked discrete actions; masked PPO beats random/heuristic baselines in-distribution, with deck-dependent results and leave-one-out transfer gaps across archetypes. No superhuman or even strong-human MTG agent was found. [pre] — [da Costa Cunha et al. 2026](https://arxiv.org/abs/2605.06066)
- **Behaviour cloning of an MCTS bot plateaus** (Scripts of Tribute, deck-builder): 6,400 games / 673,619 decisions from the tournament-winning MCTS bot; accuracy stuck at ~59% across five model sizes (84K–2.3M params) and with DAgger; the 457K-parameter bot (≈5 ms/decision) won 36.9% overall and only 12–15% against the strongest MCTS bots. Author's diagnosis: the teacher relies on search information the student cannot see. [thesis, Aalborg 2026] — [Loós 2026](https://projekter.aau.dk/learning-based-decision-making-in-a-competitive-card-game-ca046171.html)
- **Slay the Spire 2, search-free RL** (2026): 6.6M-parameter entity transformer, one forward pass per decision (21–27 ms on one CPU core); 8.05% win rate at Ascension 10 averaged over characters vs 8.8% for the tree-search agent Spire Mentor on 2,000 shared games; restarts from previously visited states allocated to where runs are lost beat uniform restarts by 3.6 points on one character. [pre] — [Chen & Xie 2026](https://arxiv.org/abs/2611.12088)
- **Hearthstone Battlegrounds** (2026): a PPO agent built by LLM research agents over 20 days climbed from ~6,000 to ~15,000 ladder rating and decides in 0.03 s. [pre] — [Ma & Wang 2026](https://arxiv.org/abs/2610.33845)
- **Non-CCG card games, model-free**: DouZero (Dou Dizhu) — Deep Monte Carlo, 48 CPU cores + four 1080 Ti, 45 actors; passed the supervised (human-data) agent after ~5×10^8 timesteps (2 days) and the previous best search-based AI DeltaDou within 5×10^9 (10 days); final WP 0.586 vs DeltaDou; an actor-critic variant with the same features "fails". Suphx (Mahjong) — supervised pretraining on 4–15M human state–action pairs per model, then policy-gradient self-play; each RL agent used 1.5M games on 44 GPUs for two days; the Tenhou agent used ~2.5M games and reached 10 dan (stable rank 8.74 over 5,000+ games). [PR ICML 2021; Suphx pre] — [Zha et al. 2021](https://arxiv.org/abs/2106.06135); [Li et al. 2020](https://arxiv.org/abs/2003.13590)
- 7 Wonders Duel: an AlphaZero-inspired MCTS + transformer system (ZeusAI) is reported to play at the level of top humans (abstract only). [pre] — [Paolini et al. 2024](https://arxiv.org/abs/2406.00741)

### Inferences
- Compute separates the approaches cleanly: ByteRL-class end-to-end RL is ~10^11 frames (my estimate: 500K frames/s × 72 h ≈ 1.3×10^11 for LOCM) and far outside one PC; DouZero-class DMC is ~10^9–10^10 decisions on one 48-core, 4-GPU server; search + small learned evaluator/prior (Świechowski, Zhang & Buro) is 10^4–10^5 search games.
- Haluška & Schmid is the most transferable result for a solo developer: BC from an existing player, then PPO fine-tuning, with a 256-128 MLP, is enough to beat a big-compute agent *on a bounded set of decks*.
- A pure cloned policy without search should be expected to be weaker than the search it imitates (AAU thesis); the policy is best used as a prior/ordering inside the search or as a rollout policy.

### Gaps
- No peer-reviewed learned agents found for Gwent, Shadowverse or Flesh and Blood; MTG Arena's Sparky and Forge's AI were not found to be learned systems (not investigated in depth).
- No strength-vs-human numbers for ygo-agent or the DeNA agent.
- NFSP, AlphaHoldem and IMPALA-league specifics were not researched; no CCG application of NFSP was found.

---

## 3. Representation for a large, growing card pool

### Takeaway
Strong systems encode each card as an entity (learned id embedding and/or a vector of mechanical attributes, sometimes a language-model embedding of rules text), embed zones as pooled or attended sets, and share the card encoder between all heads; no source demonstrates zero-shot generalisation to unseen cards, and a pool of 2,680 cards with ~12 decklists favours attribute-based features over pure id embeddings.

### Cited Findings
- ByteRL (both papers): a per-card embedding layer shared by deck-building and battle policies; zone embeddings are means over the cards in the zone (deck, graveyards) through small FC stacks; minions and hand cards carry scalar features; hero embedding shared; LSTM (256) over time. Sharing the card embedding was worth 55% vs the unshared variant in LOCM. Card pools were 160 (LOCM 1.2), procedurally generated (LOCM 1.5), 350+ (Hearthstone). [pre / PR] — [Xi et al. 2023](https://arxiv.org/abs/2303.04096); [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- LOCM 1.5 generates the card set per match specifically so that agents must "generalize their play", i.e. cards must be described by attributes, not ids. [pre] — [Kowalski & Miernik 2023](https://arxiv.org/abs/2305.11814)
- ygo-agent: card information and effects are rendered to text and embedded with an LLM; embeddings are precomputed into `embed{n}.pkl` and are optional (learned embeddings otherwise). Observation tensors: `cards_` 160×41, `global_` 23, `actions_` 24×12, history actions 32×14. "Zero-shot generalization of new cards" is an unchecked roadmap item. [repo] — [sbl1996/ygo-agent](https://github.com/sbl1996/ygo-agent)
- Świechowski et al.: word2vec skip-gram embeddings of card text, 10 dimensions; more than 16 gave negligible gains. [pre] — [Świechowski et al. 2018](https://arxiv.org/abs/1808.04794)
- DeNA PTCGP: transformer over per-card feature vectors (HP, energy, moves) plus global and player features; opponent private information masked; ~3,500 cards; RL "adapts flexibly" when cards are added (no retraining time given). [blog/press] — [Inven Global 2026](https://www.invenglobal.com/articles/24133/how-reinforcement-learning-ai-tackles-the-complex-rules-of-pok%C3%A9mon-trading-card-game-pocket)
- pkm-cabt-ppo: learned 32-dim card-identity embeddings, 16-dim attack embeddings; the model card warns the weights are tied to the deck and "will play badly" with another. [repo] — [TomatoCream/pkm-cabt-ppo](https://huggingface.co/TomatoCream/pkm-cabt-ppo)
- Slay the Spire write-ups: in a card-pick model, a card-id-embedding model had the best offline accuracy (55.8%) but ranked worst in play, while a mechanical-features-only model ranked first; a separate StS2 agent used 16-dim embeddings for cards/enemies and found dropping to 8 roughly doubled training time. [blog; snippet only] — [dev.to "Good models finish last"](https://dev.to/doronsinger/part-3-good-models-finish-last-2n6a); [StS2 showcase](https://cmcour.github.io/sts2Showcase/deep-dive/neural-network/)
- DouZero encodes any set of cards (hand, a move, the union of others' hands) as a 4×15 one-hot count matrix and uses the *same* encoding for states and actions. [PR] — [Zha et al. 2021](https://arxiv.org/abs/2106.06135)
- AAIA'17: models were tested on 27 decks after training on 9, i.e. with cards unseen in training; top AUC stayed ~0.80. [PR] — [Janusz et al. 2017](https://arxiv.org/abs/1708.00730)
- Gin Rummy component study: MLP, convolutional, set-based, attention and recurrent encoders were compared and extra capacity "did little"; learned state embeddings on the value side did not help. [pre] — [Kelidari et al. 2026](https://arxiv.org/abs/2607.06854)

### Inferences
- For Ink: a per-card feature vector built from the engine's own data (cost, inkable, strength, willpower, lore, type, keywords, counts of parsed ability ops by kind) fed through a shared small MLP, optionally summed with a low-dimensional learned id embedding, then sum/mean-pooled per zone (DeepSets), matches what ByteRL and DeNA did and degrades gracefully for cards outside the trained decks. Pure id embeddings will only be trained for the ~150–250 distinct cards in 12 decklists.
- Text embeddings from a language model (ygo-agent) are cheap to precompute offline and add no play-time cost beyond a table lookup; their benefit over mechanical features is not measured anywhere found.

### Gaps
- No controlled comparison of id embeddings vs attribute features vs LM text embeddings in a CCG.
- AlphaStar-style entity encoders were not researched directly; ByteRL cites the AlphaStar autoregressive decomposition but uses mean pooling, not a transformer.

---

## 4. Action representation for long multi-action turns

### Takeaway
Every successful system turns a turn into a sequence of small masked decisions — either "pick source, then pick target" (ByteRL, DeNA) or "score each legal action with a shared network" (DouZero, pointer nets) — rather than one flat output over all compound actions.

### Cited Findings
- ByteRL Hearthstone: each play is two steps, (type, target): first select the acting card (hand card, board minion, hero power, end turn), then the target; a "decision type" input tells the net which step it is in; a 0/1 mask zeroes illegal choices; the action head is an inner product between a state/LSTM embedding and candidate card embeddings; "the action size is at most several tens at each time step". [PR] — [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- ByteRL LOCM: a single masked categorical over battle actions per step; draft/construction as 30 single-card steps. [pre] — [Xi et al. 2023](https://arxiv.org/abs/2303.04096)
- DouZero: Q(s, a) network takes the state and one candidate action (same card-matrix encoding), is evaluated for every legal action, and the argmax is played; this handles 27,472 possible moves with widely varying legal sets. One forward pass per step; "orders of magnitude faster" on CPU than search-based DeltaDou. [PR] — [Zha et al. 2021](https://arxiv.org/abs/2106.06135)
- PerfectDou instead abstracts to 621 policy outputs; inference ~6 ms/move vs ~2 ms for DouZero on one Xeon core. [PR, NeurIPS 2022] — [Yang et al. 2022](https://arxiv.org/abs/2203.16406)
- DeNA PTCGP: "atomic actions" (choose action, then target, then evolution form) assembled by an Action Builder; steps with a single legal option are auto-played without inference; the board encoding is computed once and reused across the atomic steps; all atomic steps of one compound action receive the final action's evaluation change (credit-assignment fix). [blog/press] — [Inven Global 2026](https://www.invenglobal.com/articles/24133/how-reinforcement-learning-ai-tackles-the-complex-rules-of-pok%C3%A9mon-trading-card-game-pocket)
- pkm-cabt-ppo: each legal option is encoded and scored against the board embedding plus a summary of options already picked; multi-select is sequential picks ended by a learned STOP; author: the hard part is "the action space, not capacity". [repo] — [TomatoCream/pkm-cabt-ppo](https://huggingface.co/TomatoCream/pkm-cabt-ppo)
- Scripts of Tribute thesis: a pointer design that scores actions by card content rather than slot position fixed a mismatch between position-coded actions and order-agnostic inputs. [thesis] — [Loós 2026](https://projekter.aau.dk/learning-based-decision-making-in-a-competitive-card-game-ca046171.html)
- Zhang & Buro: a "high-level" policy predicts the *set of cards played this turn*, evaluated once per turn, leaving attack/target details to cheaper heuristics; rollouts were 5–10× slower than plain ones but 10× faster than evaluating the bigger CNNs per action. [PR] — [Zhang & Buro 2017](https://skatgame.net/mburo/ps/cig17-hsai.pdf)
- Behaviour-cloning detail: dropping "pass" actions from the dataset raised strength by almost 7 points. [PR workshop] — [Haluška & Schmid 2024](https://arxiv.org/abs/2404.16689)

### Inferences
- Because the Ink engine already enumerates legal actions, the DouZero/pointer form — encode state once, encode each legal action from its card features and action kind, score with a shared head — is the simplest fit; it yields a policy prior over legal actions (softmax of scores) and needs no fixed action indexing as cards are added.

### Gaps
- No measurement found comparing autoregressive heads with per-action scoring in the same CCG.

---

## 5. Imperfect information during training

### Takeaway
Giving the *critic or the early-training agent* hidden information is a repeated, measurable but moderate win (Suphx, PerfectDou, ByteRL's "cheat" variant); explicit hand-prediction add-ons to search have a mixed record.

### Cited Findings
- Suphx "oracle guiding": first train an agent that sees all hidden tiles, then multiply the perfect-information features by a dropout mask whose keep-probability decays from 1 to 0, then continue training with the learning rate cut to one tenth and some state–action pairs rejected. RL-2 (with oracle guiding) improved over RL-1 at equal budget (1.5M games). [pre] — [Li et al. 2020](https://arxiv.org/abs/2003.13590)
- PerfectDou "perfect-training, imperfect-execution": PPO+GAE (λ 0.95, γ 1.0) where the value net sees other players' hands and the policy does not. Ablation vs DouZero at 1e9 steps: perfect-information critic WP 0.732 vs imperfect critic 0.717 (vanilla PPO without the feature design or shaped reward: 0.509). Used 880 CPU cores + 8 GPUs; final 2.5e9 steps outperformed DouZero's ~1e10. [PR] — [Yang et al. 2022](https://arxiv.org/abs/2203.16406)
- The PerfectDou repository's own round-robin shows a later DouZero ResNet variant beating PerfectDou 52.08% to 47.92%, so the advantage is not uniform. [repo; snippet only] — [PerfectDou GitHub](https://github.com/godmoves/perfectdou)
- ByteRL "cheat": letting the learner see the first n1 cards of the opponent's deck, with the opponent seeing n2 ≤ n1, added 5.5 points; the cheating model needs that information at play time, and was evaluated as a separate agent. [PR] — [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- ByteRL's LOCM MCTS experiment searched on the true hidden state, which the authors note is game-theoretically unsafe. [pre] — [Xi et al. 2023](https://arxiv.org/abs/2303.04096)
- Świechowski et al. built their first value dataset (≈3.5M samples, 400 decks) from a "cheater" MCTS that saw hidden information. Zhang & Buro trained their policy on open-hand games. [pre / PR] — [Świechowski et al. 2018](https://arxiv.org/abs/1808.04794); [Zhang & Buro 2017](https://skatgame.net/mburo/ps/cig17-hsai.pdf)
- LOCM ProphetCoac's opponent-hand prediction reduced overall win rate (less search time). [pre] — [Kowalski & Miernik 2023](https://arxiv.org/abs/2305.11814)
- DeNA masks the opponent's private information in the model input. [blog/press] — [Inven Global 2026](https://www.invenglobal.com/articles/24133/how-reinforcement-learning-ai-tackles-the-complex-rules-of-pok%C3%A9mon-trading-card-game-pocket)

### Inferences
- For a value net used at the leaves of a determinized search, the leaf is a fully specified sampled world, so training the net on perfect-information states (as Świechowski's first dataset did) is consistent with how it is used; the imperfect-information handling then lives in how worlds are sampled.

### Gaps
- No quantified result found for belief/hand-prediction auxiliary heads in a CCG.

---

## 6. Deck dependence

### Takeaway
Per-deck or per-class models are consistently more accurate or stronger than one general model at equal budget, and agents trained on a small fixed deck set are strong on it but fragile off it; deck diversity during training (random decks, random first picks, opponent pools) is the documented counter-measure.

### Cited Findings
- ByteRL Hearthstone: splitting into one model per hero raised win rate 6.5 points (tripling compute). Random-CB (first n ∈ {0,1,2,4} deck picks uniformly random with probabilities 0.5/0.25/0.125/0.125) was added to diversify decks; the agent rebuilt a known human archetype (Flamewaker Mage) from scratch. [PR] — [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- Haluška & Schmid: win rate of the fine-tuned exploiter vs ByteRL falls monotonically with the number of training deck pools — 0.904 (32), 0.822 (64), 0.803 (128), 0.801 (256), 0.734 (512), 0.542 (1,024). [PR workshop] — [Haluška & Schmid 2024](https://arxiv.org/abs/2404.16689)
- Świechowski: per-deck and per-seat value nets were more accurate than general ones; experiments used just two decks. [pre] — [Świechowski et al. 2018](https://arxiv.org/abs/1808.04794)
- Riot LoR: started with 1 deck, expanded to 10; 48% vs top humans. [blog] — [Anyscale 2022](https://www.anyscale.com/blog/riot-games-and-deep-reinforcement-learning-in-gaming)
- DeNA: one model plays ~540 predefined decks plus user decks after 50M episodes. [blog/press] — [Inven Global 2026](https://www.invenglobal.com/articles/24133/how-reinforcement-learning-ai-tackles-the-complex-rules-of-pok%C3%A9mon-trading-card-game-pocket)
- ygo-agent: the demo trains one deck; many decks is described as requiring distributed training; "fast fine-tuning methods for new decks" is future work. pkm-cabt-ppo agents are single-deck and break on other decks. [repo] — [sbl1996/ygo-agent](https://github.com/sbl1996/ygo-agent); [TomatoCream/pkm-cabt-ppo](https://huggingface.co/TomatoCream/pkm-cabt-ppo)
- MTG-Causal-RL reports deck-dependent results and uses leave-one-archetype-out transfer gaps as a metric. [pre] — [da Costa Cunha et al. 2026](https://arxiv.org/abs/2605.06066)
- LOCM draft: before 2022, drafting was "dominated by handcrafted or experimentally adjusted heuristics" equivalent to a fixed card ordering; ByteRL's joint draft+battle training beat alternating training (81% vs 68% against DrainPower in v1.2). [pre] — [Kowalski & Miernik 2023](https://arxiv.org/abs/2305.11814); [Xi et al. 2023](https://arxiv.org/abs/2303.04096)

### Inferences
- With ~12 meta lists, Ink should train on all 12×12 matchups from the start and hold out one or two decks (and perturbed lists, e.g. a few random card swaps, the analogue of random-CB) to measure overfitting; conditioning inputs should include the bot's own remaining deck composition (pooled card features), which ByteRL also feeds in.

### Gaps
- No source quantifies how many distinct decks are needed before a CCG agent generalises to unseen constructed decks.

---

## 7. Data and compute budgets; what 10^5–10^7 games on one PC can buy; sample-efficiency tricks

### Takeaway
Published end-to-end RL budgets are 10^8–10^11 decisions on hundreds to thousands of cores; the budgets that fit one PC (10^4–10^6 search games, 10^6–10^7 fast games) match the search-plus-small-net recipes and small fixed-deck PPO/BC agents, and search-improved targets, auxiliary targets and playout-cap randomisation are the documented efficiency levers.

### Cited Findings
| System | Budget | Hardware | Source |
|---|---|---|---|
| ByteRL LOCM 1.5 | ~72 h at ~500K frames/s | 24 "units", each 1 V100 + 600 CPU cores | [Xi 2023](https://arxiv.org/abs/2303.04096) |
| ByteRL Hearthstone b4 | 23 days | 24 V100 + 5,856 CPU cores | [Xiao 2023](https://arxiv.org/abs/2303.05197) |
| DouZero | 5×10^8 steps to beat SL; 5×10^9 to beat DeltaDou; trained 30 days | 48 cores + 4× 1080 Ti | [Zha 2021](https://arxiv.org/abs/2106.06135) |
| PerfectDou | 2.5×10^9 steps | 880 cores + 8 GPUs | [Yang 2022](https://arxiv.org/abs/2203.16406) |
| Suphx | SL on 4–15M samples per model; 1.5–2.5M self-play games | 44 GPUs, 2 days per RL run | [Li 2020](https://arxiv.org/abs/2003.13590) |
| ygo-agent release | "over 100M games" | "32 4090 GPUs for 5 days" equivalent | [README](https://github.com/sbl1996/ygo-agent) |
| DeNA PTCGP | 50M episodes per model | 6 × 32-vCPU machines | [Inven Global 2026](https://www.invenglobal.com/articles/24133/how-reinforcement-learning-ai-tackles-the-complex-rules-of-pok%C3%A9mon-trading-card-game-pocket) |
| Świechowski HS value net | 20,000 + 64×3,000 MCTS games; 1M-sample buffer | not stated (simulator ~10K games/s) | [Świechowski 2018](https://arxiv.org/abs/1808.04794) |
| Zhang & Buro HS policy | 3 × 27,000 search games (10,000 rollouts/move) | single PCs | [Zhang & Buro 2017](https://skatgame.net/mburo/ps/cig17-hsai.pdf) |
| Haluška & Schmid LOCM BC | 110,000 matches, 2.3M pairs | not stated | [Haluška 2024](https://arxiv.org/abs/2404.16689) |
| AAU Scripts of Tribute BC | 6,400 games, 673,619 decisions | not stated | [Loós 2026](https://projekter.aau.dk/learning-based-decision-making-in-a-competitive-card-game-ca046171.html) |
| KataGo | 19 days, ≤28 V100 (~1.4 GPU-years) vs ELF's ~74 GPU-years | — | [Wu 2019](https://arxiv.org/abs/1902.10565) |

- KataGo efficiency methods (about 50× less compute than ELF OpenGo to surpass it): **playout cap randomisation** — a random 25% of moves get a full search (N = 600, later 1,000 playouts) and the rest a fast one (n = 100, later 200), so games finish quickly (more value samples) while policy targets come from good searches; it "clearly outperforms" every fixed playout count tried (100–600). **Auxiliary targets** — predicting board ownership and final score difference, and the opponent's next move; removing ownership/score caused "a noticeable drop in learning efficiency". Forced playouts with policy-target pruning gave smaller gains. The author notes strong amateur level is reachable "on even single GPUs in mere days". [pre] — [Wu 2019](https://arxiv.org/abs/1902.10565)
- AlphaZero.jl Connect Four: about one hour per training iteration on an i5-9600K + RTX 2070; the net alone ends "significantly stronger" than a depth-5 minimax baseline. [repo] — [AlphaZero.jl](https://github.com/jonathan-laurent/AlphaZero.jl)
- ByteRL noted that with a capacity-limited net, doubling or tripling batch size/GPUs/CPUs did not improve results. [PR] — [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- DouZero: more actors speed wall-clock learning but sample efficiency is unchanged; Monte Carlo targets tolerate high variance because the simulator produces samples cheaply. [PR] — [Zha et al. 2021](https://arxiv.org/abs/2106.06135)
- Reward shaping: PerfectDou used a shaped "oracle" reward (minimum steps to empty the hand) in main training and removed it for final fine-tuning; removing it entirely raised win percentage slightly (0.738 vs 0.732) but hurt score margin (ADP 0.490 vs 1.270). The Gin Rummy study found short- and longer-term shaping did not help. DeNA added a targeted penalty for one self-damaging move. [PR / pre / blog] — [Yang et al. 2022](https://arxiv.org/abs/2203.16406); [Kelidari et al. 2026](https://arxiv.org/abs/2607.06854); [Inven Global 2026](https://www.invenglobal.com/articles/24133/how-reinforcement-learning-ai-tackles-the-complex-rules-of-pok%C3%A9mon-trading-card-game-pocket)
- Play-time cost of small nets on CPU: DouZero ~2 ms/step, PerfectDou ~6 ms (one Xeon core); 457K-param pointer net ~5 ms/decision; 6.6M-param entity transformer 21–27 ms/decision on one core. [PR / thesis / pre] — [Yang et al. 2022](https://arxiv.org/abs/2203.16406); [Loós 2026](https://projekter.aau.dk/learning-based-decision-making-in-a-competitive-card-game-ca046171.html); [Chen & Xie 2026](https://arxiv.org/abs/2611.12088)

### Inferences
- Arithmetic for Ink (from the stated 80 scripted games/s/core): 10^5 scripted games ≈ 21 core-minutes, 10^6 ≈ 3.5 core-hours, 10^7 ≈ 35 core-hours. Search games are slower by roughly the number of simulations per decision; at 100× slower, an 8-core PC produces on the order of 5×10^5 search games per day — already more than Świechowski's entire 212,000-game run and about six times Zhang & Buro's 81,000.
- Pure model-free RL to ByteRL/ygo-agent strength (10^8+ games) is out of reach; a DouZero-style DMC run of 10^9 decisions would take weeks on one PC and has no CCG precedent at that scale.
- Lorcana analogues of KataGo's auxiliary targets are cheap to log from the engine: final lore difference, turns until the game ends, and (from the DeNA/KataGo pattern) the opponent's next action. Playout-cap randomisation maps directly onto "full-budget search on a quarter of decisions, fast search on the rest".
- All the cited small nets run in milliseconds on one CPU core, so a few-hundred-thousand-parameter MLP/DeepSets model evaluated at search leaves in plain JavaScript or ONNX fits a sub-second decision budget; the binding cost is the number of leaf evaluations per search, not a single forward pass.

### Gaps
- No published learning curve for an AlphaZero/ExIt-style loop on a CCG at 10^5–10^7 games on consumer hardware; Świechowski is the closest and does not report hardware.
- Total self-play game counts for AlphaZero.jl and for ByteRL are not stated in the pages read.

---

## 8. Using a few thousand human replays

### Takeaway
Human data has been used successfully only at the scale of millions of expert decisions (Suphx) or a decade of ladder replays (Metamon); with a few thousand games the supported uses are a warm start, a validation set and an evaluation opponent model, and bot-generated search data is the larger and cleaner imitation source.

### Cited Findings
- Suphx pretrains five models on 4M–15M state–action pairs from top human players (test accuracy 76.7% for discard) and also trains its global reward predictor on human logs; RL then improves on the supervised agent. [pre] — [Li et al. 2020](https://arxiv.org/abs/2003.13590)
- DouZero trained without human data and beat a supervised agent trained on 49,990,075 human samples within two days; its agreement with human moves rose during the first five days of training and then fell sharply while strength kept rising. [PR] — [Zha et al. 2021](https://arxiv.org/abs/2106.06135)
- Metamon (competitive Pokémon battles): reconstructs first-person views from third-person spectator logs of a decade-plus of human battles, trains transformers by imitation → offline RL → fine-tuning on self-play data; reached the top 10% of active ladder players with no search. [PR, RLC 2025] — [Grigsby et al. 2025](https://arxiv.org/abs/2504.04395)
- BC pretraining improves subsequent RL, more so as the task gets broader (LOCM: +4 to +20 points vs random init at 32, 64, 256, 512 and 1,024 deck pools; 1 point worse at 128), with the value head still trained from scratch. [PR workshop] — [Haluška & Schmid 2024](https://arxiv.org/abs/2404.16689)
- BC alone compounds errors: 36.9% overall and 12–15% vs strong MCTS bots after cloning the best MCTS bot from 673,619 decisions; DAgger did not lift the plateau. In the Gin Rummy study imitation learning and DAgger were among the components that did *not* help. [thesis / pre] — [Loós 2026](https://projekter.aau.dk/learning-based-decision-making-in-a-competitive-card-game-ca046171.html); [Kelidari et al. 2026](https://arxiv.org/abs/2607.06854)
- Slay the Spire card-pick models that were better at predicting human picks performed worse when actually guiding play. [blog; snippet only] — [dev.to "Good models finish last"](https://dev.to/doronsinger/part-3-good-models-finish-last-2n6a)

### Inferences
- A few hundred to a few thousand human-vs-bot games (perhaps 10^4–10^5 decisions, from players of unknown skill, all against one weak bot) is 2–3 orders of magnitude below the datasets that worked. Their distribution is also biased toward positions where humans are beating the current bot.
- Useful roles for them: (a) held-out positions to check that the value net's predictions are calibrated on human-style games, not only bot-style ones; (b) a small-weight warm start for the policy prior, weighted toward winners' moves; (c) a source of opening states/decks for self-play. Search-generated labels (Zhang & Buro's 27,000 games per matchup) can be produced locally in any quantity.

### Gaps
- No study found on behaviour cloning from only ~10^3 human CCG games, or on weighting schemes by player skill in CCGs.
- Metamon's replay count and model sizes were not in the abstract read.

---

## 9. Pitfalls documented by practitioners

### Takeaway
The recurring failures are measurement failures (weak yardsticks, uncontrolled seat/deck luck, tiny samples) and data-pipeline failures (correlated or stale samples, leaked labels, self-play against only the latest self).

### Cited Findings
- **Weak yardsticks**: baseline agents beat random >99% of the time, "so random play is a weak yardstick" (Gin Rummy study). ygo-agent's 3-minute model scores 98% vs random yet 3.1% vs the trained checkpoint. pkm-cabt-ppo's author calls its vs-random numbers a sign that training works, not a strength rating. [pre / repo] — [Kelidari et al. 2026](https://arxiv.org/abs/2607.06854); [ygo-agent](https://github.com/sbl1996/ygo-agent); [pkm-cabt-ppo](https://huggingface.co/TomatoCream/pkm-cabt-ppo)
- **Seat and deck confounds**: in Świechowski's setup the first-player deck won 73.5% under identical bots, so results are reported per seat. ByteRL evaluates 2 (seat) × 3 × 3 (heroes) × 2,500 matches per comparison. DouZero plays each deal twice with sides swapped to cut variance; Suphx needed one million evaluation games to stabilise its metric. [pre / PR] — [Świechowski et al. 2018](https://arxiv.org/abs/1808.04794); [Xiao et al. 2023](https://arxiv.org/abs/2303.05197); [Zha et al. 2021](https://arxiv.org/abs/2106.06135); [Li et al. 2020](https://arxiv.org/abs/2003.13590)
- **Correlated samples**: consecutive states of one game are highly correlated — subsample (p = 0.5 in Świechowski; one position per game in ExIt). [pre / PR] — [Świechowski et al. 2018](https://arxiv.org/abs/1808.04794); [Anthony et al. 2017](https://arxiv.org/abs/1705.08439)
- **Label leakage**: the AAIA'17 organisers had to add 1.25M states after a data leak was found in the original training set. [PR] — [Janusz et al. 2017](https://arxiv.org/abs/1708.00730)
- **Non-stationarity / stale data**: ByteRL gained from throttling actors with a FIFO queue instead of a ring buffer so that each sample is used a controlled number of times and off-policy lag stays small. [PR] — [Xiao et al. 2023](https://arxiv.org/abs/2303.05197)
- **Strategy cycling / self-play collapse**: ByteRL mixes 60% latest-self with 40% historical checkpoints chosen by payoff and gates pool entry at >70% vs all members; Haluška & Schmid nevertheless found the resulting agent "highly exploitable". Suphx reports RL is sensitive to policy entropy (too low: self-play stops improving) and controls it toward a target. The Gin Rummy study found a curriculum of progressively tougher opponents and keeping the best checkpoint both helped. [pre / PR workshop] — [Xi et al. 2023](https://arxiv.org/abs/2303.04096); [Haluška & Schmid 2024](https://arxiv.org/abs/2404.16689); [Li et al. 2020](https://arxiv.org/abs/2003.13590); [Kelidari et al. 2026](https://arxiv.org/abs/2607.06854)
- **Objective teaches the wrong thing**: DouZero agents trained for win rate vs score margin adopt different styles (the win-rate agent plays bombs more conservatively); γ = 0.99 mis-specified the win/loss objective for ByteRL; PerfectDou drops its shaped reward before the end. [PR] — [Zha et al. 2021](https://arxiv.org/abs/2106.06135); [Xiao et al. 2023](https://arxiv.org/abs/2303.05197); [Yang et al. 2022](https://arxiv.org/abs/2203.16406)
- **Offline accuracy ≠ playing strength**: equal top-1 error but a 50-Elo gap between ExIt target types; the best human-pick predictor was the worst in-game guide (StS blog, snippet only); a 59%-accurate clone wins 12–15% vs its teacher's peers. [PR / blog / thesis] — [Anthony et al. 2017](https://arxiv.org/abs/1705.08439); [dev.to](https://dev.to/doronsinger/part-3-good-models-finish-last-2n6a); [Loós 2026](https://projekter.aau.dk/learning-based-decision-making-in-a-competitive-card-game-ca046171.html)
- **Features that steal search time**: hand prediction lowered ProphetCoac's win rate under a fixed time limit. [pre] — [Kowalski & Miernik 2023](https://arxiv.org/abs/2305.11814)
- **Engineering order**: the Oracle team used supervised training on known-good data first to find architecture limits and bugs in the self-play loop. [blog; snippet only] — [Oracle "Lessons from AlphaZero: Connect Four"](https://medium.com/oracledevs/lessons-from-alphazero-connect-four-e4a0ae82af68)

### Inferences
- An Ink arena should fix a gauntlet (scripted bot, current search bot, earlier checkpoints), mirror every game with seats swapped on the same seed/deck pair, cover the full deck matrix, and run enough games for the margin being claimed (ByteRL used 45,000 per comparison; by the binomial standard error 0.5/√n, resolving a 2-point edge at two standard errors needs about 2,500 games and at four about 10,000).
- Because the engine is deterministic and seeded, mirrored-seed evaluation and StS2-style restarts from stored positions are both available at no extra engineering cost.

### Gaps
- No practitioner post-mortem by a hobbyist who trained a CCG agent end to end on one PC was found; the pitfalls above are drawn from papers, READMEs and adjacent games.
