# Retrace on MCR-bench: defect state tracking

Task: a defect was raised in an earlier review round. After the next push, is it **Resolved** or still **Open**? 3131 cases from 558 PRs (py,js,ts,java,csharp); 71.6% resolved. The push touched the defect's file in 76.7% of cases.

**False-resolved rate** is the share of still-open defects a system wrongly calls fixed: the "forgetting" failure. **Resolved recall** is the share of real fixes it recognises: missing them means re-flagging fixed code, the "temporal misalignment" failure. 95% CIs come from resampling whole PRs.

| System | Accuracy | Balanced acc. | Resolved recall | Resolved precision | False-resolved rate | Abstained |
|---|---|---|---|---|---|---|
| Always open | 28.4% (26.0%–30.6%) | 50.0% | 0.0% | – | 0.0% (0.0%–0.0%) | 0.0% |
| Always resolved | 71.6% (69.4%–74.0%) | 50.0% | 100.0% | 71.6% | 100.0% (100.0%–100.0%) | 0.0% |
| File touched ⇒ resolved | 69.8% (68.1%–71.7%) | 60.2% | 82.5% | 77.1% | 62.0% (57.9%–66.6%) | 0.0% |
| Lines touched ⇒ resolved | 61.8% (59.9%–63.7%) | 59.8% | 64.5% | 78.4% | 44.9% (41.4%–49.0%) | 0.0% |
| Retrace (Jev) | 62.5% (60.7%–64.3%) | 70.2% | 52.4% | 91.7% | 12.0% (9.8%–14.6%) | 18.5% |
| Retrace (Jev, no file filter) | 65.2% (63.3%–66.9%) | 71.7% | 56.7% | 91.5% | 13.3% (10.8%–15.9%) | 23.9% |

- **Always open**: Never trusts a fix. What you get if the ledger is never updated.
- **Always resolved**: Assumes every push fixes everything (majority class).
- **File touched ⇒ resolved**: Resolved if this push changed the defect's file.
- **Lines touched ⇒ resolved**: Resolved if this push changed lines near the defect.
- **Retrace (Jev)**: File filter + Jev; only `fixed` counts as resolved, `unsure` stays open.
- **Retrace (Jev, no file filter)**: Also asks Jev when the defect's file wasn't touched, with the whole push diff. More calls; catches fixes made elsewhere.

## By review round (balanced accuracy)

| System | Round 2 (n=1135) | Round 3 (n=980) | Round 4 (n=550) | Round 5+ (n=466) |
|---|---|---|---|---|
| Always open | 50.0% | 50.0% | 50.0% | 50.0% |
| Always resolved | 50.0% | 50.0% | 50.0% | 50.0% |
| File touched ⇒ resolved | 57.7% | 61.5% | 61.7% | 65.1% |
| Lines touched ⇒ resolved | 56.5% | 61.1% | 62.2% | 65.1% |
| Retrace (Jev) | 70.0% | 70.8% | 69.5% | 71.2% |
| Retrace (Jev, no file filter) | 71.3% | 72.0% | 71.0% | 73.6% |

## By severity (false-resolved rate: lower is safer)

| System | Blocker/Critical/Major (n=793) | Normal/Minor/Trivial (n=2338) |
|---|---|---|
| Always open | 0.0% | 0.0% |
| Always resolved | 100.0% | 100.0% |
| File touched ⇒ resolved | 57.1% | 64.9% |
| Lines touched ⇒ resolved | 41.3% | 47.0% |
| Retrace (Jev) | 9.7% | 13.4% |
| Retrace (Jev, no file filter) | 11.9% | 14.1% |

## Retrace cost

- Jev coverage: 3131/3131 cases scored (the rest are missing answers and count as abstained).
- 23.3% of cases needed **no model call** (file untouched).
- 3131 Jev calls (both variants), 3,744,190 input tokens, ≈ $0.1573 total.
- Latency per call: median 205 ms, p95 250 ms.

## Calibration of P(fixed)

| P(fixed) bin | Cases | Actually resolved |
|---|---|---|
| 0.0–0.2 | 722 | 54.3% |
| 0.2–0.4 | 242 | 73.6% |
| 0.4–0.6 | 232 | 78.0% |
| 0.6–0.8 | 299 | 81.6% |
| 0.8–1.0 | 906 | 94.4% |

Brier score: 0.252 (lower is better; 2401 cases where Jev was called).

## Tuned threshold (dev/test split by PR)

Smallest threshold with false-resolved ≤ 5.0% on dev (941 cases): **0.8**. On held-out test (2190 cases): false-resolved 6.1%, resolved recall 37.8%, balanced accuracy 65.9%.

## Caveats

- MCR-bench labels come from an LLM annotation pipeline (3 runs + consistency check), not human review.
- Defect text is the annotator's summary, not the original reviewer comment, and may be cleaner than real review threads.
- This scores state tracking only. It doesn't measure finding new defects (MCR-bench's main precision/recall/F1 task).
