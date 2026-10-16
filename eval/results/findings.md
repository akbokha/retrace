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

**Reading it:** Sonnet is measurably but modestly better at ranking, and the gap only shows at the looser operating point. At the strict setting (≤5% wrongly closed) they're tied. Jev gets ~97% of Sonnet's AUROC for ~1.4% of the cost at ~1/8 of the latency.

**Cascade (exploratory):** let Jev decide when it's confident and send only its uncertain cases to Sonnet:

| Send to Sonnet when Jev's P(addressed) is in | Share sent | Cost / 1k | AUROC | Recall @ ≤12% |
|---|---|---|---|---|
| never (Jev only) | 0% | $0.06 | 0.759 | 51.7% |
| 0.3–0.9 | 51% | $2.31 | 0.771 | 59.6% |
| always (Sonnet only) | 100% | $4.44 | 0.775 | 60.0% |

Escalating half the checks recovers almost all of Sonnet's gain at the 12% operating point, for about half its cost. These bands were picked on the test split itself, so treat them as a direction to validate, not a result. At the strict 5% setting the cascade doesn't help.

**Caveat:** both systems top out around AUROC 0.76–0.78. Given the label noise found in section 1, part of that ceiling is probably the labels, not the models.
