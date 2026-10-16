# Retrace on MCR-bench: defect state tracking

Task: a defect was raised in an earlier review round. After the next push, is it **Resolved** or still **Open**? 3131 cases from 558 PRs (py,js,ts,java,csharp); 71.6% resolved. The push touched the defect's file in 76.7% of cases.

**False-resolved rate** is the share of still-open defects a system wrongly calls fixed: the "forgetting" failure. **Resolved recall** is the share of real fixes it recognises: missing them means re-flagging fixed code, the "temporal misalignment" failure. 95% CIs come from resampling whole PRs.

| System | Accuracy | Balanced acc. | Resolved recall | Resolved precision | False-resolved rate | Abstained |
|---|---|---|---|---|---|---|
| Always open | 28.4% (26.0%–30.6%) | 50.0% | 0.0% | – | 0.0% (0.0%–0.0%) | 0.0% |
| Always resolved | 71.6% (69.4%–74.0%) | 50.0% | 100.0% | 71.6% | 100.0% (100.0%–100.0%) | 0.0% |
| File touched ⇒ resolved | 69.8% (68.1%–71.7%) | 60.2% | 82.5% | 77.1% | 62.0% (57.9%–66.6%) | 0.0% |
| Lines touched ⇒ resolved | 61.8% (59.9%–63.7%) | 59.8% | 64.5% | 78.4% | 44.9% (41.4%–49.0%) | 0.0% |
| Retrace (Jev) | 65.3% (63.4%–67.0%) | 71.6% | 56.9% | 91.3% | 13.6% (11.2%–16.0%) | 12.4% |
| Retrace (Jev, no file filter) | 67.8% (66.0%–69.6%) | 73.1% | 61.0% | 91.2% | 14.9% (12.1%–17.5%) | 15.8% |

- **Always open**: Never trusts a fix. What you get if the ledger is never updated.
- **Always resolved**: Assumes every push fixes everything (majority class).
- **File touched ⇒ resolved**: Resolved if this push changed the defect's file.
- **Lines touched ⇒ resolved**: Resolved if this push changed lines near the defect.
- **Retrace (Jev)**: File filter + Jev; ✅ when P(addressed) ≥ 0.76, everything else stays open.
- **Retrace (Jev, no file filter)**: Also asks Jev when the defect's file wasn't touched, with the whole push diff. More calls; catches fixes made elsewhere.

## By review round (balanced accuracy)

| System | Round 2 (n=1135) | Round 3 (n=980) | Round 4 (n=550) | Round 5+ (n=466) |
|---|---|---|---|---|
| Always open | 50.0% | 50.0% | 50.0% | 50.0% |
| Always resolved | 50.0% | 50.0% | 50.0% | 50.0% |
| File touched ⇒ resolved | 57.7% | 61.5% | 61.7% | 65.1% |
| Lines touched ⇒ resolved | 56.5% | 61.1% | 62.2% | 65.1% |
| Retrace (Jev) | 71.8% | 73.1% | 69.9% | 70.9% |
| Retrace (Jev, no file filter) | 72.6% | 74.2% | 71.8% | 73.6% |

## By severity (false-resolved rate: lower is safer)

| System | Blocker/Critical/Major (n=793) | Normal/Minor/Trivial (n=2338) |
|---|---|---|
| Always open | 0.0% | 0.0% |
| Always resolved | 100.0% | 100.0% |
| File touched ⇒ resolved | 57.1% | 64.9% |
| Lines touched ⇒ resolved | 41.3% | 47.0% |
| Retrace (Jev) | 11.2% | 15.0% |
| Retrace (Jev, no file filter) | 13.7% | 15.6% |

## Retrace cost

- Jev coverage: 3131/3131 cases scored (the rest are missing answers and count as abstained).
- 23.3% of cases needed **no model call** (file untouched).
- 3131 Jev calls (both variants), 4,425,429 input tokens, ≈ $0.1859 total.
- Latency per call: median 214 ms, p95 263 ms.

## Calibration of P(addressed)

| P(addressed) bin | Cases | Actually resolved |
|---|---|---|
| 0.0–0.2 | 263 | 45.6% |
| 0.2–0.4 | 255 | 49.4% |
| 0.4–0.6 | 261 | 63.6% |
| 0.6–0.8 | 321 | 74.8% |
| 0.8–1.0 | 1301 | 92.1% |

Brier score: 0.162 (lower is better; 2401 cases where Jev was called).

## Tuned threshold (dev/test split by PR)

Smallest threshold with false-resolved ≤ 5.0% on dev (941 cases): **0.9**. On held-out test (2190 cases): false-resolved 3.8%, resolved recall 37.3%, balanced accuracy 66.8%.

## Caveats

- MCR-bench labels come from an LLM annotation pipeline (3 runs + consistency check), not human review.
- Defect text is the annotator's summary, not the original reviewer comment, and may be cleaner than real review threads.
- This scores state tracking only. It doesn't measure finding new defects (MCR-bench's main precision/recall/F1 task).
