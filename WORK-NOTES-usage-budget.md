# Work notes: gateway budget + thread cost (prototype)

Temporary notes. This branch (`notes/usage-budget`) only adds this file on top of
`feat/usage-gateway-budget`; never merge it into a PR branch.

## Context

Claude Code runs through an LLM gateway (LiteLLM-style, monthly spend budget per user).
T3 Code had no way to show that budget, nor the cost of the current thread.

Public discussions (posted as ZaBug):

- #15042 Generic HTTP `usageLimitSources` kind for gateway budgets: open, no maintainer reply yet.
  Maintainer bot confirmed it is not a duplicate.
- #15043 Thread cost in the Context Window popover: closed as a duplicate of #13073.
  Details were folded into a comment on #13073, which also got an upvote.
- CONTRIBUTING: features need explicit maintainer approval in Ideas before a PR.
  PR #10904 (OpenRouter source) was closed for missing approval.

## Done (branch `feat/usage-gateway-budget`, on top of upstream main 736130c2fd)

### Gateway budget source (#15042), 8 commits, the first ones on the branch

| Commit     | What                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| e0cf9a0c54 | contracts: `http` kind in `usageLimitSources`, optional `spend` amount on windows (shape from #14911) |
| c038c8480b | server: `httpUsageSource.ts` reads mapped JSON (dot paths), with clear per-path errors                |
| 0154488f35 | server: polling + `provider.testUsageLimitSource` RPC (Test before save)                              |
| fc606dae9c | web: Limits card shows the amount                                                                     |
| 7b0b5e0c90 | web: settings dialog gets an "HTTP endpoint" type, field mapping and a Test button                    |
| e8a2f72f2c | web: mapping fields prefilled with LiteLLM paths; a bare token is sent as `Bearer`                    |
| 25c7083570 | web: errors show the HTTP status and a hint (e.g. 403, check the auth header)                         |
| 7a1babd110 | web: amount follows the remaining direction ("$X left of $Y"), ready for #14469                       |

A clean PR branch can be cut with `git branch pr/budget 7a1babd110`.

### Thread cost (#13073), 5 commits on top

| Commit     | What                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 32f872206e | server: each Claude turn stores its share of `total_cost_usd` (delta per CLI process; a drop is treated as a reset) |
| 8fbc32bfcc | server: `server.estimateUsageCost` RPC, priced from LiteLLM rates plus `usagePriceOverrides`                        |
| 4cf62235ee | web: "Thread cost" row in the Context Window popover, with its source label                                         |
| 3fce583340 | web: optional composer badge (`$1.4 · 32%`)                                                                         |
| 495efadedd | web: "Monthly budget" line in the popover; depends on both features and can be dropped                              |

These commits reuse `formatMoney` from budget commit fc606dae9c.

### Verified manually

- Against the real gateway: the dialog Test shows spend, max, soft limit and reset date.
  The Limits card and the popover budget line render.
- A real Claude turn: Thread cost matches Claude's reported figure. The first turn costs about $1,
  mostly a ~163k-token cache write, driven largely by many MCP tool definitions.

## Known gaps / open issues

- Compat: an undecodable `usageLimitSources` entry fails the whole `settings.json` decode.
  An older build that sees an `http` source falls back to default settings.
  Needs a tolerant record schema; mention it to the maintainers.
- Thread cost appears only for turns made with this build. Imported V1 threads have no
  per-turn token usage, so neither the context meter nor the cost shows until a new turn.
  Possible backfill: estimate from Claude transcripts on disk (approach of closed PR #9136).
- The estimate misses subagent usage; Claude's reported cost includes it.
- There is no picker for which budget source the popover shows; it uses the first `http` source.
- Soft limit is parsed and shown in Test only, not on the Limits card.
- Open UX question: should the percent be relative to the soft limit instead of max?
- Not done: mobile, user docs. `useResetCredit` has the same error-extraction bug (out of scope).
- `UsagePage.test.tsx` cannot run on Windows (`node:sea` bundling); this predates our changes.

## Next steps

1. Comment on #15042 with prototype screenshots taken against a local mock server
   (generic $42.50 / $1,000 data, no internal URLs). Ask for approval of the direction
   and raise the compat note.
2. After approval: rebase on upstream/main, cut `pr/budget` from the budget commits, open the PR.
3. Optional: backfill thread cost from transcripts; percent relative to the soft limit.
4. Optional personal build: desktop build from this branch with
   `T3CODE_DISABLE_AUTO_UPDATE=true`; rebase and rebuild roughly weekly.

## Local dev notes (Windows)

- Toolchain: `vp` (vite-plus, installed per user). On flaky networks, install with
  `vp i -- --network-concurrency=3 --fetch-timeout=600000 --fetch-retries=6`.
- Run with an isolated home only: `vp run dev --home-dir <dir>`. Never point it at `~/.t3/userdata`.
- To get a new pairing token for a running server: from `apps/server`, run
  `vp exec node src/bin.ts pair --base-dir <dir>`.
- To seed real data, snapshot the database with `VACUUM INTO` into `<home>/userdata/state.sqlite`.
  V2 imports it into `statev2.sqlite` on first start.
