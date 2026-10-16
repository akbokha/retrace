# Retrace on MCR-bench: defect state tracking

Task: a defect was raised in an earlier review round. After the next push, is it **Resolved** or still **Open**? 3131 cases from 558 PRs (py,js,ts,java,csharp); 71.6% resolved. The push touched the defect's file in 76.7% of cases.

**False-resolved rate** is the share of still-open defects a system wrongly calls fixed: the "forgetting" failure. **Resolved recall** is the share of real fixes it recognises: missing them means re-flagging fixed code, the "temporal misalignment" failure. 95% CIs come from resampling whole PRs.

| System | Accuracy | Balanced acc. | Resolved recall | Resolved precision | False-resolved rate | Abstained |
|---|---|---|---|---|---|---|
| Always open | 28.4% (26.0%–30.6%) | 50.0% | 0.0% | – | 0.0% (0.0%–0.0%) | 0.0% |
| Always resolved | 71.6% (69.4%–74.0%) | 50.0% | 100.0% | 71.6% | 100.0% (100.0%–100.0%) | 0.0% |
| File touched ⇒ resolved | 69.8% (68.1%–71.7%) | 60.2% | 82.5% | 77.1% | 62.0% (57.9%–66.6%) | 0.0% |
| Lines touched ⇒ resolved | 61.8% (59.9%–63.7%) | 59.8% | 64.5% | 78.4% | 44.9% (41.4%–49.0%) | 0.0% |

- **Always open**: Never trusts a fix. What you get if the ledger is never updated.
- **Always resolved**: Assumes every push fixes everything (majority class).
- **File touched ⇒ resolved**: Resolved if this push changed the defect's file.
- **Lines touched ⇒ resolved**: Resolved if this push changed lines near the defect.

## By review round (balanced accuracy)

| System | Round 2 (n=1135) | Round 3 (n=980) | Round 4 (n=550) | Round 5+ (n=466) |
|---|---|---|---|---|
| Always open | 50.0% | 50.0% | 50.0% | 50.0% |
| Always resolved | 50.0% | 50.0% | 50.0% | 50.0% |
| File touched ⇒ resolved | 57.7% | 61.5% | 61.7% | 65.1% |
| Lines touched ⇒ resolved | 56.5% | 61.1% | 62.2% | 65.1% |

## By severity (false-resolved rate: lower is safer)

| System | Blocker/Critical/Major (n=793) | Normal/Minor/Trivial (n=2338) |
|---|---|---|
| Always open | 0.0% | 0.0% |
| Always resolved | 100.0% | 100.0% |
| File touched ⇒ resolved | 57.1% | 64.9% |
| Lines touched ⇒ resolved | 41.3% | 47.0% |

## Caveats

- MCR-bench labels come from an LLM annotation pipeline (3 runs + consistency check), not human review.
- Defect text is the annotator's summary, not the original reviewer comment, and may be cleaner than real review threads.
- This scores state tracking only. It doesn't measure finding new defects (MCR-bench's main precision/recall/F1 task).
