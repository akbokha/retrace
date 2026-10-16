# What we learned tuning Retrace on MCR-bench

## 1. Spot check: "resolved" defects that Jev scored P(fixed) < 0.2

392 file-touched cases were labelled Resolved while the first version of Retrace (v0, a 4-way choice) gave them P(fixed) < 0.2. A random sample of 30 was read by hand (by Claude, not a human annotator), with the full push diff checked for fixes hidden by truncation:

| What happened | Cases | Whose fault |
|---|---|---|
| No fix anywhere in this push: fixed in an earlier commit, reviewer accepted the code as-is, or a wrong label. One push *adds* the separate import the defect asks to remove. | 13 (43%) | Label noise. Jev was right. |
| Fix made in another file: file moved to another package, logic extracted to a base class. Jev only saw the commented file. | 6 (20%) | Retrace design gap |
| Jev missed a visible fix: `List` → `IList` exactly as asked, blank lines added as asked, a "document the limitation" request answered with a TODO. | 7 (23%) | Jev / question wording |
| Ambiguous or partial | 4 (13%) | — |

So **roughly 40–45% of these apparent misses are label noise**, and Retrace's measured recall understates it. The fixable problems were the design gap (other files) and the question wording, which led to the variants below.

## 2. Question variants

Protocol: PRs are split 30/70 by hash. Variants were compared on the 30% dev split only; the winner was then run once on the 70% held-out split.

| Variant | What changed |
|---|---|
| v0 | 4-way choice (fixed / partially / not addressed / made worse) on the commented file's diff |
| v1 | Yes/no "has the concern been addressed?", counting accepted alternatives (documented, done another way) |
| v2 | v1 + commit messages of the push + diffs of up to 4 other changed files (moves and same-name files first) |

Dev split (941 cases):

| Variant | AUROC | Recall @ ≤12% false-resolved | Brier |
|---|---|---|---|
| v0 | 0.732 | 52.0% | 0.320 |
| v1 | 0.738 | 52.4% | 0.263 |
| v2 | **0.750** | **57.6%** | **0.250** |

The wording alone (v1) barely moved the ranking but improved calibration. The extra context (v2) is what helped.

Held-out test split (2,190 cases), with thresholds picked on dev:

| | Recall | False-resolved | Balanced acc. |
|---|---|---|---|
| v0 as first shipped | 51.9% | 12.1% | 69.9% |
| **v2, threshold 0.76** | **56.1%** | 13.9% | **71.1%** |
| v0, strict threshold 0.8 | 37.8% | 6.1% | 65.9% |
| **v2, strict threshold 0.88** | **42.1%** | 6.0% | **68.1%** |

v2 is now what the Action ships (`fixed-threshold` defaults to 0.76). Cost of the whole tuning exercise: about $0.35 in Jev calls.

## Limits

- Labels come from MCR-bench's LLM annotation pipeline. The spot check suggests a substantial share of "resolved" labels have no matching code change in that round.
- 30 cases is a small sample. Treat the percentages in section 1 as rough.
- The full-dataset numbers in `report.md` include the dev PRs used to pick v2. The held-out numbers above are the unbiased ones.

## 3. Jev vs an LLM (Claude Sonnet 5.5)

Same state, same question, on the 2,190 held-out cases (1,656 needing a model call). Sonnet ran with thinking off and low effort, the fastest way to deploy it for yes/no checks, and stated a probability in a structured answer. Jev returns real probabilities. `npm run llm` reproduces it; full table in [`llm-claude-sonnet-5-5.md`](llm-claude-sonnet-5-5.md).

| | Jev | Sonnet 5.5 | Sonnet − Jev (95% CI, PR bootstrap) |
|---|---|---|---|
| AUROC | 0.759 | 0.775 | +0.015 [0.008, 0.024] |
| Recall @ ≤5% false-resolved | 37.3% | 37.8% | about equal |
| Recall @ ≤12% false-resolved | 51.7% | 60.0% | +8.3 pts [1.9, 11.3] |
| Brier (calibration) | 0.165 | 0.168 | about equal |
| **Cost per 1,000 checks** | **$0.06** | $4.38 | **~70× more** |
| **Median / p95 latency** | **215 / 265 ms** | 1,669 / 2,975 ms | **~8× / 11× slower** |

**Correction (see §5):** the recall columns above use each system's best threshold *on the test cases*. This first version of the section read that as "tied at the strict setting". With thresholds tuned on dev and applied to test, Sonnet recognises 6–9 points more real fixes than Jev at the same strict false-resolved rate. The AUROC, calibration, cost and latency figures stand.

**Cascade (exploratory, superseded by §5):** let Jev decide when it's confident and send only its uncertain cases to Sonnet:

| Send to Sonnet when Jev's P(addressed) is in | Share sent | Cost / 1k | AUROC | Recall @ ≤12% |
|---|---|---|---|---|
| never (Jev only) | 0% | $0.06 | 0.759 | 51.7% |
| 0.3–0.9 | 51% | $2.31 | 0.771 | 59.6% |
| always (Sonnet only) | 100% | $4.44 | 0.775 | 60.0% |

Escalating half the checks recovers almost all of Sonnet's gain at the 12% operating point, for about half its cost. These bands were picked on the test split itself, so treat them as a direction to validate, not a result. At the strict 5% setting the cascade doesn't help.

**Caveat:** both systems top out around AUROC 0.76–0.78. Given the label noise found in section 1, part of that ceiling is probably the labels, not the models.

## 4. v3: several narrow Jev questions + a learned combiner

Goal: more confidence that a ✅ thread is really resolved. v3 asks seven narrow questions in one Jev call (addressed, touched, *problem still present*, *specific suggestion applied*, *only partially done*, commits mention review, fixed in another file). A logistic regression trained on the dev PRs combines them with cheap facts the Action has (commented lines touched, file deleted, review words in commits, round). Seven questions cost about the same as two, because Jev bills the shared input once. `npm run v3 -- --split dev`, then `--split test`. Full table in [`v3.md`](v3.md).

Dev, cross-validated: recall at ≤5% false-resolved went from 44.7% (v2) to 49.5% (v3). On held-out PRs:

| | Jev v2 | Claude Sonnet 5.5 | Jev v3 |
|---|---|---|---|
| AUROC | 0.759 | 0.775 | 0.768 |
| Recall @ ≤5% false-resolved | 37.3% | 37.8% | 38.7% |
| Recall @ ≤2% false-resolved | 22.4% | 30.3% | 30.2% |
| Cost per 1,000 checks | $0.06 | $4.38 | $0.06 |

PR-bootstrap 95% CIs for v3 − v2 and v3 − Sonnet at both strict settings all include zero (e.g. v3 − Sonnet @ 2%: [−8.1, +13.9] pts). So v3 doesn't measurably beat v2 or Sonnet at the strict settings. (This section originally said v3 "matches" Sonnet there. That used best-on-test thresholds and wide intervals; §5's dev-tuned comparison shows Sonnet ahead of Jev at the strict settings.) At these error budgets only a few hundred cases decide the result, so the comparison is noisy.

The threshold chosen on dev (0.87, aiming for 5% false-resolved) gave 8.9% on held-out PRs, so it doesn't transfer cleanly yet. Choosing it from out-of-fold predictions on dev would be the principled fix. v3 is **not shipped**: the gain isn't significant and its threshold isn't stable.

What the combiner learned (standardised weights) is itself informative: *problem still present* (−0.65) and *only partially done* (−0.49) are the strongest signals, stronger than the broad *addressed* question (+0.36). Asking about the remaining problem works better than asking whether it was fixed.

## 5. More context from the papers, and the cascade, done properly

### More context doesn't help Jev here

Three context signals the papers recommend, added one at a time to the shipped v2 questions (`npm run v4 -- --split dev`). I checked that none of them leak information from after the push being judged: in all 1,147 rows with discussion, every comment predates that push.

| Variant (source) | Dev AUROC |
|---|---|
| v2 (shipped) | 0.750 |
| + PR title and description (ContextCRBench: intent beats extra code) | 0.749 |
| + this file's earlier pushes since the comment (MCR-Bench, History Matters: cross-round memory) | 0.752 |
| + review discussion before the push (History Matters) | 0.748 |
| all three | 0.752 |
| average of all views (SWRBench: aggregation) | 0.752 |

None of these moved ranking quality. Differences at the 2% budget swing by several points but rest on ~4 errors in ~200 still-open dev cases, so they're noise. ContextCRBench's large gains from PR descriptions don't carry over to this task, at least not for Jev.

### Jev vs Sonnet vs cascade, with dev-tuned thresholds

Sonnet's answers on the dev PRs (745 calls, $3.27) made it possible to tune every threshold on dev and test once (`npm run cascade`, full table in [`cascade.md`](cascade.md)). Target ≤5% false "fixed":

| Held-out PRs | Thresholds | Recall | False-resolved | Precision of ✅ | Cost / 1k |
|---|---|---|---|---|---|
| Jev alone | ≥0.88 | 41.9% | 6.3% | 94.2% | $0.06 |
| Sonnet alone | ≥0.91 | 49.5% | 5.6% | 95.5% | $4.38 |
| **Cascade** | Jev ≥0.74, then Sonnet ≥0.89 | 49.7% | 6.3% | 95.1% | **$2.68** |

- **Sonnet − Jev recall: [+5.9, +9.5] pts.** At honest operating points the LLM is clearly more accurate than Jev alone.
- **Cascade − Sonnet: recall [−1.0, +1.5] pts, false-resolved [−0.3, +1.6] pts.** Same accuracy as Sonnet, with the LLM called on 60% of checks.
- At a ≤3% target the cascade buys more recall (+4 to +7 pts) at a slightly higher false-resolved rate (+0.4 to +3.0 pts), so it's a different point on the curve, not a clean win.

**Conclusion:** Jev alone is the cheap, fast option. It's ~70× cheaper and ~8× faster than Sonnet but less accurate at strict settings. Jev as a filter in front of an LLM keeps the LLM's accuracy for ~40% less cost. The Action ships the cascade as an option (`verifier-model`).
