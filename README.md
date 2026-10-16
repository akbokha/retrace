# 🔁 Retrace

**Your PR has 14 review comments and you just pushed a fix. Which ones did you actually address?**

Retrace is a GitHub Action that keeps a ledger of every review thread on a pull request, whether from humans, Copilot, CodeRabbit or your own review bot. On every push it tells you which threads look **fixed**, **partially fixed**, **still open** or **made worse**, with a history across review rounds (illustrative example):

| Review comment | File | Now | History by round |
|---|---|---|---|
| Race condition: two concurrent requests can both charge… | `src/payments.ts` | 🟡 partially fixed (81%) | 🔴 → 🟡 |
| `userId` can be undefined here | `src/api/user.ts` | ✅ likely fixed (92%) | 🔴 → ⏸️ → ✅ |
| Missing test for empty cart | `test/cart.test.ts` | 🔴 still open (88%) | 🔴 → 🔴 → 🔴 |

It doesn't write review comments itself. It works alongside whatever already writes them.

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

> Secrets aren't available to workflows triggered from forks, so Retrace only runs on PRs from branches in the same repo.

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
npm run build   # bundles to dist/index.js. Commit dist/ (GitHub runs it directly).
```

## Evaluation on MCR-bench

[MCR-bench](https://github.com/DeepSoftwareAnalytics/MCR-bench) (Apache-2.0) has 558 real PRs with 2–10 review rounds. Each defect is labelled with its state in every round. Retrace's question maps directly onto it: *a defect was open going into this push; afterwards, is it **Resolved** or still **Open**?* That gives **3,131 cases** (71.6% resolved).

```bash
./eval/fetch-data.sh                               # ~60 MB, into eval/data/
npm run eval                                       # baselines, no API key needed
TYPESAFE_API_KEY=sk-... npm run eval -- --jev      # + Retrace (~2.4k Jev calls, cached)
npm run eval -- --jev --jev-all                    # + variant without the file filter
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

### Jev vs an LLM

Same state and question, on the held-out PRs, against Claude Sonnet 5.5 (thinking off, the fastest way to deploy it for yes/no checks):

| | Jev | Claude Sonnet 5.5 |
|---|---|---|
| AUROC | 0.759 | 0.775 (+0.015, CI excludes 0) |
| Recall @ ≤5% false-resolved | 37.3% | 37.8% |
| Recall @ ≤12% false-resolved | 51.7% | 60.0% |
| Cost per 1,000 checks | **$0.06** | $4.38 (~70×) |
| Median latency | **215 ms** | 1,669 ms (~8×) |

Sonnet is modestly better at the looser operating point and tied at the strict one. Jev gets ~97% of its ranking quality for ~1.4% of the cost. Sending only Jev's uncertain cases to Sonnet recovers most of the gap for about half Sonnet's cost ([details](eval/results/findings.md#3-jev-vs-an-llm-claude-sonnet-55)).

## Roadmap

- [x] Evaluation harness on MCR-bench (state tracking)
- [ ] Run Retrace through MCR-bench's own review-generation eval, paired with an LLM reviewer
- [ ] Calibrated thresholds (conformal risk control) for a guaranteed recall target on "still open"
- [ ] Classify developer replies ("done", "won't fix", disputes) and verify "done" claims
- [ ] Deduplicate new bot comments against the ledger before posting
- [ ] Cascade: escalate only Jev-uncertain threads to an LLM, with bands tuned on dev PRs

## License

MIT
