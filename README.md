# k-daemon

K is a sovereign personal agent — a chief-of-values that does not own the values. It runs on
your machine, holds your life's record locally, and exists to free your attention, not to
harvest it. This repository is the daemon: the substrate, the reasoning lanes, the build
factory, and the senses.

k-daemon is the open mirror of a living system built n=1 for its founder. It is published so
the ideas and the engineering are inspectable and reusable — not as a hosted product. There is
no server to sign up for. You are the server.

## What K is

- **A substrate, not a feed.** Everything K knows lives in local JSON under `data/` — exposures
  (what you attended to), idea atoms (open loops), decisions, body signals. Nothing leaves the
  machine except calls you explicitly route (see Sovereignty).
- **Advisory by default.** K reasons and stages recommendations; a human decides. The strongest
  move K has is a card waiting for your verdict. Tool calls are held unless you granted them.
- **A cadence, not a dashboard.** The primary surface is the day itself: one now-instrument,
  the next block, quiet nudges under a per-category attention budget. Silence is a first-class
  output.
- **A factory that builds itself.** The build runner plans units, dispatches coding lanes in
  git worktrees, verifies, and integrates — gated by a safety floor (protected files require
  human-reviewed integration), scope-drift checks, and decision cards.

## Principles

These are load-bearing; the code enforces most of them.

1. **Sovereignty.** Sensitive turns route only to lanes you control (`K_SOVEREIGN_PROVIDER`);
   substrate context never reaches a non-sovereign model. Data dir is never committed.
2. **Attention is the currency.** Every surface pays for itself or stays silent. Budgets cap
   nudges per category per day; over-budget items queue, they don't interrupt.
3. **Truth first, anti-glaze.** K does not praise, flatter, or mirror to create agreement.
   Missing data is named plainly, never imputed. Every rate carries its denominator.
4. **Advisory-first autonomy.** K may act only through granted tools; everything else is a
   staged recommendation with an undo story.
5. **Silence-default.** If a sentence would not change what you do next, it is not rendered.
6. **Honest instrumentation.** The eval measures whether decisions get acted on and whether
   life-signal resolves — never engagement.

## Voice

K speaks like a quiet peer who did the work: plain prose, no markdown theatrics, second person,
terse, no exclamation marks, numbers rounded to what a human can use. Entities are named as
human noun phrases. Pipeline scaffolding (ids, template keys, raw floats) stays in payloads,
never in copy. The full voice chart and text patterns live in [PRINCIPLES.md](PRINCIPLES.md).

## Architecture

- `daemon/server.mjs` — HTTP daemon (bind: loopback/tailnet), chat, cadence, build, body, mind routes
- `src/agent/` — chat shell, tool loop, build runner/lanes/cards, cadence engine, attention budget
- `src/mind/` — think/dream passes over the substrate: themes, open loops, edge cards, model-named entities
- `src/ingest/` — senses: self-syncing adapters (biosignals, WHOOP, notes, bookmarks) — consent-first, dedup-idempotent, fail-soft
- `src/reason/` — model lanes: sovereign (yours) and frontier (optional), think-scrubbed streaming
- `contracts/` — the wire-contract fixture; client repos vendor it and fail tests on drift

## Running

```
npm install
cp .env.example .env.local   # set your model lane(s)
node daemon/server.mjs
```

The iOS client lives at [k-app](../../../k-app). Point it at your daemon's address.

## License

AGPL-3.0 — see [LICENSE](LICENSE). Chosen deliberately: a sovereignty tool should not be
enclosable. If you run a modified K for others, they get the source too.
