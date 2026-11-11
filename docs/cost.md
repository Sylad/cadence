[← cadence](../README.md)

# `cadence cost`: the cost of a mechanism, before any bench (L693)

A bench costs hours and dollars. Before running one, `cadence cost` estimates what a way of working costs, from a short description of
its rollout and the known rules of how a Claude session is billed. No model is called, no journal is read.

```
cadence cost <rollout.json|yaml> [--config cadence.yaml] [--json]
```

The price comes from the rollout (`prices`) or from the grid `perf.prices` of `cadence.yaml` ([perf](perf.md)), the one of the current folder
or the one `--config` names, under the rollout's `model`; `perf.currency` is written after the amounts. Exit 1, with the reason on stderr and
nothing on stdout, for an unreadable file, a malformed rollout (an unknown key, a negative number, a share above 1…) or a model with no price.

## The rollout

```json
{
  "model": "claude-opus-5-5",
  "cacheWriteFactor": 2,
  "defaults": { "base": 67000, "kept": 0.98 },
  "sessions": [
    { "label": "step 1", "exchanges": 51, "growth": 2538, "output": 847 },
    { "label": "steps 2 and 3", "exchanges": 50, "growth": 1300, "output": 500, "repeat": 2 },
    { "label": "same session, kept", "exchanges": 20, "growth": 1100, "output": 600, "continues": true }
  ]
}
```

| key | meaning |
|---|---|
| `model` | the model, a key of `perf.prices` |
| `prices` | optional, `{ input, output, cacheRead }` per million tokens, instead of the grid |
| `cacheWriteFactor` | optional, the price of a cache write as a multiple of the input price; 2 by default (the one-hour cache of Claude Code), 1.25 for the five-minute cache |
| `defaults` | optional, keys given to every session that does not set them |
| `sessions[].exchanges` | calls to the model in the session (one tool turn is one call) |
| `sessions[].base` | context sent with the first call: the base the session loads (system prompt, `CLAUDE.md`, tools, request) |
| `sessions[].growth` | tokens added to the context by each call: the model's output plus the tool results |
| `sessions[].output` | tokens produced per call (billed output, thinking included) |
| `sessions[].kept` | share of the context sent again that is read from the cache, between 0 and 1; the rest is written to it |
| `sessions[].continues` | the session starts from the context the previous one left (a kept session) instead of `base` |
| `sessions[].repeat` | how many times the session is played, 1 by default |

## The rule

Each call sends the whole context again. A session of E calls that starts from a context C₀ and grows by g per call sends
C₀ + (i − 1)·g at call i, E·C₀ + g·E(E − 1)/2 in all: `kept` of it is read from the cache at the `cacheRead` price, the rest is written at the
input price × `cacheWriteFactor`. The output is E × `output` at the output price. The session leaves a context of C₀ + E·g, the one a
`continues` session takes up. The uncached input (about a hundred tokens per session in the journals) is left out.

The output prints the price line, one line per session (calls, context at start and end, tokens read, written, produced, cost) and the total.

## Calibrated on the bench 2026-11-10-1551-b4bcc9ea9150

The bench `aether-b68-court` played the same three steps twice (r1, r2) with two arms: c1 opens a new session per step, c2 keeps one session
across the three steps (with a `/compact` before step 2). The rollouts of the four runs are in
[`test/fixtures/cost-banc-2026-11-10/`](../test/fixtures/cost-banc-2026-11-10/), and `test/cost-estimate-l693.test.ts` checks each estimate
within ±20 % of the real cost:

| run | real cost | `cadence cost` | gap |
|---|---|---|---|
| new session, r1 | 8.42 $ | 7.86 $ | −7 % |
| new session, r2 | 9.14 $ | 8.23 $ | −10 % |
| kept session, r1 | 10.01 $ | 9.18 $ | −8 % |
| kept session, r2 | 9.08 $ | 8.41 $ | −7 % |

The estimate runs about 8 % low: the context does not grow linearly (large reads early in a session), the rule assumes it does.

**Measured, from the session journals** (`~/.claude/projects/…-aether-b68-court-<run>-<arm>/<session>.jsonl`, one API call counted once per
message id, within the step's `debut`/`fin`): per step, `exchanges` (the calls), `base` (the context of the first call), `growth` ((last − first
context) / (calls − 1)), `output` (output / calls), `kept` (cache read / context sent); for the compaction, its one call from the `cost-state`
records. The prices are fitted on the 14 `cost-state` records of the four sessions (the cost Claude Code computes, with its four counters),
and reproduce every one within half a cent: **output 20 $/M, cache read 0.20 $/M, cache write 8 $/M** (all writes are one-hour writes).

**Supposed**: the input price, 4 $/M. The journals cannot measure it (a hundred uncached input tokens per session weigh less than 0.1 % of the
cost): it is the write price over 2, the one-hour write factor. The cache read is then 5 % of the input price, not the 10 % usually quoted.
Also supposed: the linear growth of the context and a constant `kept` within a session.

## What the bench counted

The bench reports 31.52 $ and 29.66 $ for the kept session (`cout_usd` of `etape-<k>.c2.json` in `resultat.json`); the journals say 10.01 $ and
9.08 $. A resumed session's cost record is cumulative: the bench added, for each step, the session's running total since its start (step 2
even adds two of them, the one after `/compact` and the one at the end of the step: 6.37 + 8.89 = 15.26 $ in r1). The kept session's tokens
are counted the same way: 79.2 M reported in r1 for 24.9 M really sent. Real cost per run: kept session 10.01 $ against 8.42 $ for new
sessions in r1 (+19 %), 9.08 $ against 9.14 $ in r2 (−1 %), not ×3.5. The new-session figures are right (one session per step).

## Limits

- `cadence perf` and `orchestrate` price a cache write at the input price (`src/cost.ts`), so they count the one-hour writes at half their price; on this bench writes were a third of the cost.
- One model per rollout: a mechanism that mixes models is two rollouts.
- Subagents are sessions of their own: describe them as sessions.
