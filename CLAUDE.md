# Working on Ink

Ink is a Disney Lorcana deck builder and online table: an Express server (`server.js`, `lib/`), a rules engine
(`game/`), and a static client (`public/`). It runs in Docker on Kieran's PC and is public at
https://ink.strmlight.com through a Cloudflare tunnel.

## Branches: live on main

"Main" here is the `master` branch (the repository's default).

- Work on `master` locally. Check it out at the start of a session and stay there; don't leave work sitting on
  other branches.
- To publish changes, don't push to `master` directly. Make a branch from where you are (e.g. `fix/issue-30`,
  `feat/quest-all`), push that branch, and open a pull request into `master` with `gh pr create --base master`.
  Then come back to `master`.
- Merging the PR is Kieran's call unless he says to merge it. After it merges, update local `master`
  (`git pull origin master`) and delete the short-lived branch.
- Old branches (`lorcana-engineV1`, `local/mip-lod-bias`) are history, not places to work.

## Authorship: Kieran only

Commits, pull requests and GitHub comments carry only Kieran's name.

- Commit with `git -c user.name="Kieran Bendell" -c user.email="Kieran@bendell.ca" commit …`.
- No `Co-Authored-By`, "Generated with Claude Code" or similar lines in commit messages, PR descriptions or
  comments, whatever a default suggests. Comments go through `gh`, which posts as Kieran's account.
- Put `Fixes #N` on its own line for each issue a change fixes (GitHub only reads the first issue in a
  comma-separated list), so the issues close when the PR merges.

## Before committing

Run the engine suites; all must pass:

```
node scripts/test-effects.mjs
node scripts/test-procs.mjs
node scripts/sim-games.mjs 60
node scripts/sim-games.mjs 100 1 --chaos
pnpm run verify
```

Add a regression test to `scripts/test-effects.mjs` for an engine bug, and check it fails without the fix.
`pnpm run verify` rewrites `scripts/verify/cr-trace.md`; revert that file rather than committing it unless the
change is meant to move the trace. UI changes get checked in the browser preview (`.claude/launch.json`, port 3000).

## Deploying

The live site is the `ink` container, built from this checkout:

```
docker compose up -d --build ink
```

Rebuild after changes that should go live. Accounts, decks and replays live in the `ink-data` volume and survive a
rebuild. Configuration is in `.env` (never committed): `PUBLIC_URL`, `INK_ADMINS`, `INK_WORKER_TOKEN`, the tunnel
token.

## GitHub issues (Adam files most of them)

1. Check each issue is real before fixing it: read the code, reproduce it, and for rules questions check the
   Comprehensive Rules in `docs/rules/` and the card FAQ in `cache/sanitized.db` (`rules.faq`).
2. Fix the valid ones; say plainly which aren't valid and why.
3. Once fixed and deployed, reply on each issue as Kieran in plain language: what was wrong and what changed.
4. Close issues through the PR's `Fixes #N` lines; close by hand only what a merge didn't close.

## Admin and issue worker

`/admin` (moderators and admins) shows the GitHub issue board, report history, users and invite links.
`pnpm issue-worker` runs on this PC: it files reports from `/admin` as GitHub issues and opens a terminal running
Claude on each. See the README section "Roles and the admin page".
