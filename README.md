# 🔁 Retrace

**Your PR has 14 review comments and you just pushed a fix. Which ones did you actually address?**

Retrace is a GitHub Action that keeps a ledger of every review thread on a pull request, whether from humans, Copilot, CodeRabbit or your own review bot. On every push it tells you which threads look **fixed**, **partially fixed**, **still open** or **made worse**, with a history across review rounds (illustrative example):

| Review comment | File | Now | History by round |
|---|---|---|---|
| Race condition: two concurrent requests can both charge… | `src/payments.ts` | 🟡 partially fixed (81%) | 🔴 → 🟡 |
| `userId` can be undefined here | `src/api/user.ts` | ✅ likely fixed (92%) | 🔴 → ⏸️ → ✅ |
| Missing test for empty cart | `test/cart.test.ts` | 🔴 still open (88%) | 🔴 → 🔴 → 🔴 |

It doesn't write review comments itself. It works alongside whatever already writes them.

**Short on time?** Read the one-page [TL;DR](TLDR.md), or see it working on the [live demo PR](https://github.com/akbokha/retrace/pull/1).

## Why

AI code reviewers handle a single round reasonably well but degrade across rounds. [MCR-Bench](https://arxiv.org/abs/2608.27442) (2,269 real multi-round review tasks) reports F1 falling 10–30% from round 2 to round 10. The main causes:

- **Temporal misalignment:** re-flagging defects that were already fixed. This is the biggest source of false positives.
- **Cross-round forgetting:** losing track of defects raised earlier. This is the biggest source of false negatives.

[SWE-PRBench](https://arxiv.org/abs/2603.26130) also finds that dumping more raw context into a reviewer makes it *worse*, while small, structured context works better.

So Retrace treats re-review as **state tracking**, not regeneration. It also uses the cheapest tool that can answer each question.

## How it works

```
push ──► for each open review thread:
           │
           ├─ file not in this push?  ──► ⏸️ untouched (plain code, no model call)
           │
           └─ file changed ──► small state: hunks near the commented lines + commit messages
                                              + up to 4 related files (moves, same name/folder)
                               ──► Jev (one call, three typed questions):
                                     addressed: noul   "has the reviewer's concern been addressed?"  ≥ 0.76 ⇒ ✅
                                     touched:   noul   "does this change modify the commented code?"
                                     outcome:   choice partially_fixed | not_addressed | made_worse
                               ──► low confidence? ──► ❔ unsure (never guesses)
                               ──► optional: Jev ≥ 0.74 ⇒ an LLM must also agree before ✅
         ──► update one sticky PR comment (ledger stored inside it as hidden JSON, so no server or database)
```

[Jev](https://typesafe.ai) is a "System One" decision model. It returns calibrated probabilities instead of text, at about 100 ms and $0.042 per million input tokens. That makes it a good fit for small, high-volume judgments like "is this thread resolved?". An LLM is better kept for writing reviews.

**Retrace never resolves a thread on its own.** ✅ means "worth re-checking first", not "verified".

## Quickstart

1. Get a TypeSafe API key (see [Jev access](#jev-access) below) and add it to your repo as the secret `TYPESAFE_API_KEY` (*Settings → Secrets and variables → Actions*).
2. Add `.github/workflows/retrace.yml`:

```yaml
name: Retrace
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  retrace:
    runs-on: ubuntu-latest
    steps:
      - uses: akbokha/retrace@v0
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

That's it. Leave a review comment, push a commit, and watch the Retrace comment update.

| Input | Default | |
|---|---|---|
| `typesafe-api-key` | required | Jev key, or a key for any Jev-compatible server |
| `typesafe-base-url` | Jev's API | Point at a self-hosted [Kev](https://github.com/jaredpalmer/kev) server so code never leaves your infra |
| `model` | `jev-latest` | |
| `fixed-threshold` | `0.76` | Jev's P(addressed) needed for ✅. `0.88` is stricter: ~6% false "fixed" on held-out MCR-bench PRs |
| `min-confidence` | `0.6` | Below this, a thread is marked ❔ unsure |
| `verifier-model` | off | Optional cascade, e.g. `claude-sonnet-5-5`: an LLM must confirm every ✅. Matches Sonnet's accuracy at ~60% of its cost ([results](#jev-vs-an-llm-and-the-cascade)) |
| `anthropic-api-key` | | Needed for `verifier-model` |
| `verifier-gate` / `verifier-threshold` | `0.74` / `0.89` | Jev's P(addressed) needed before asking the verifier, and the verifier's needed for ✅. Tuned on dev PRs for ≤5% false "fixed" |

With the cascade:

```yaml
      - uses: akbokha/retrace@v0
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          verifier-model: claude-sonnet-5-5
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

> Secrets aren't available to workflows triggered from forks. On those PRs Retrace skips with a notice instead of failing. After a force-push or rebase it leaves statuses unchanged until the next regular push, because the rewritten history can't be diffed against the previous head.

## Jev access

Jev is hosted by TypeSafe AI and currently in early access. Request a key at [typesafe.ai](https://typesafe.ai). No Jev access? [Kev](https://github.com/jaredpalmer/kev) is an Apache-2.0 model family that serves the same `POST /v1/systemone` API. Run it yourself and set `typesafe-base-url`.

## Try it locally

```bash
npm install
TYPESAFE_API_KEY=sk-... npm run try
```

This runs Jev on one payment race-condition comment against three pushes: a full fix, a partial fix and an unrelated logging change.

## Development

```bash
npm run typecheck
npm test
npm run build   # bundles to dist/index.js. Commit dist/ (GitHub runs it directly; CI checks it's up to date).
```

## Evaluation on MCR-bench

[MCR-bench](https://github.com/DeepSoftwareAnalytics/MCR-bench) (Apache-2.0) has 558 real PRs with 2–10 review rounds. Each defect is labelled with its state in every round. Retrace's question maps directly onto it: *a defect was open going into this push; afterwards, is it **Resolved** or still **Open**?* That gives **3,131 cases** (71.6% resolved).

```bash
./eval/fetch-data.sh                               # ~60 MB, into eval/data/
npm run eval                                       # baselines, no API key needed
TYPESAFE_API_KEY=sk-... npm run eval -- --jev      # + Retrace (~2.4k Jev calls, cached)
npm run eval -- --jev --jev-all                    # + variant without the file filter
npm run llm -- --split dev && npm run llm          # Claude Sonnet 5.5 on dev and held-out PRs (ANTHROPIC_API_KEY)
npm run cascade                                    # Jev vs Sonnet vs cascade, thresholds tuned on dev
```

It reports accuracy with PR-level bootstrap CIs, a breakdown by round and severity, Jev's cost and latency, calibration of P(addressed), and a threshold tuned on a dev split of PRs. The two numbers that matter:

- **False-resolved rate:** still-open defects called fixed. This is the *forgetting* failure, and the dangerous one.
- **Resolved recall:** real fixes recognised. Missing them means re-flagging fixed code, the *temporal misalignment* failure.

Results on all 3,131 cases with `jev-latest` (full report in [`eval/results/report.md`](eval/results/report.md)):

| System | Balanced acc. | Resolved recall | Resolved precision | False-resolved rate (95% CI) |
|---|---|---|---|---|
| File touched ⇒ resolved | 60.2% | 82.5% | 77.1% | 62.0% (57.9–66.6%) |
| Lines touched ⇒ resolved | 59.8% | 64.5% | 78.4% | 44.9% (41.4–49.0%) |
| Retrace v0 (4-way choice, commented file only) | 70.2% | 52.4% | 91.7% | 12.0% (9.8–14.6%) |
| **Retrace (shipped)** | **71.6%** | **56.9%** | **91.3%** | **13.6%** (11.2–16.0%) |
| Retrace (shipped, no file filter) | 73.1% | 61.0% | 91.2% | 14.9% (12.1–17.5%) |

- **About 4× fewer "forgotten" defects** than the diff heuristics. When Retrace says ✅, it's right 91% of the time.
- **No decay across rounds:** balanced accuracy stays between 70% and 73% from round 2 through round 5+. The ledger carries state, so later rounds aren't harder.
- **Cheap:** 3,131 Jev calls for **$0.19 total**, median 214 ms per call. 23% of cases need no model call at all.
- **Calibrated, so the threshold is a usable dial:** P(addressed) ≥ 0.8 is 92% actually resolved (Brier 0.162). `fixed-threshold: 0.88`, tuned on dev PRs, gives about 6% false-resolved on held-out PRs at 42% recall.
- **The trade-off:** recall is modest, and ❔ unsure threads (12%) default to "still open", the safe direction. A hand-checked sample suggests [roughly 40% of the apparent misses are label noise](eval/results/findings.md) (no fix exists in that push), so true recall is higher than measured.
- **17.5% of real fixes land in a push that never touches the defect's file.** Removing the file filter (`--jev-all`) recovers part of that (+4 points recall) for 30% more calls.

### How the shipped questions were chosen

The first version asked a 4-way choice about the commented file alone. A [spot check of its misses](eval/results/findings.md) found two fixable causes: fixes made in *other* files (moves, extracted base classes), and a question that leaned toward "partially fixed". Three variants were compared on a 30% dev split of PRs, and the winner was confirmed once on the 70% held-out split:

| Held-out PRs (2,190 cases) | Recall | False-resolved | Balanced acc. |
|---|---|---|---|
| v0: 4-way choice, commented file | 51.9% | 12.1% | 69.9% |
| **v2: yes/no "addressed?" + commit messages + other changed files** | **56.1%** | 13.9% | **71.1%** |

Rewording alone (v1) barely helped. The extra context is what made the difference. Reproduce with `npm run variants -- --variant v2 --split dev`.

### Jev vs an LLM, and the cascade

Same state and question, against Claude Sonnet 5.5 (thinking off, the fastest way to deploy it for yes/no checks). Every threshold was tuned on the dev PRs and applied unchanged to the 2,190 held-out cases, targeting ≤5% false "fixed" ([`eval/results/cascade.md`](eval/results/cascade.md)):

| | Recall | False-resolved | Precision of ✅ | Cost / 1k checks | Median latency |
|---|---|---|---|---|---|
| Jev alone | 41.9% | 6.3% | 94.2% | **$0.06** | **215 ms** |
| Claude Sonnet 5.5 alone | 49.5% | 5.6% | 95.5% | $4.38 | 1,669 ms |
| **Cascade: Jev filters, Sonnet confirms** | **49.7%** | 6.3% | 95.1% | **$2.68** | 215 ms for the 40% Jev filters out |

- **Sonnet is more accurate than Jev alone:** 6–9 points more recall at the same strict false-resolved rate (95% CI [5.9, 9.5]). Jev's advantage is cost (~70× cheaper) and latency (~8× faster), not accuracy.
- **The cascade matches Sonnet's accuracy for ~40% less:** recall difference vs Sonnet alone [−1.0, +1.5] pts, false-resolved [−0.3, +1.6] pts. Jev handles the clear "not fixed" cases on its own, and Sonnet only sees the ~60% Jev finds likely addressed. Turn it on with `verifier-model` (below).

An earlier version of this README said Jev and Sonnet were tied at the strict setting. That compared each at its best threshold *on the test data*, which flattered Jev. The dev-tuned comparison above is the correct one.

## Roadmap

- [x] Evaluation harness on MCR-bench (state tracking)
- [ ] Run Retrace through MCR-bench's own review-generation eval, paired with an LLM reviewer
- [ ] Calibrated thresholds (conformal risk control) for a guaranteed recall target on "still open"
- [ ] Deduplicate new bot comments against the ledger before posting
- [x] Cascade: Jev filters, an LLM confirms ✅ (thresholds tuned on dev PRs)
- [ ] Use thread replies ("done in abc123") as context. Not evaluated yet: MCR-bench doesn't link replies to threads

## License

MIT
