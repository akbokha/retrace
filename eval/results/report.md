# Retrace on MCR-bench: defect state tracking

Task: a defect was raised in an earlier review round. After the next push, is it **Resolved** or still **Open**? 5 cases from 5 PRs (py,js,ts,java,csharp); 100.0% resolved. The push touched the defect's file in 60.0% of cases.

**False-resolved rate** is the share of still-open defects a system wrongly calls fixed: the "forgetting" failure. **Resolved recall** is the share of real fixes it recognises: missing them means re-flagging fixed code, the "temporal misalignment" failure. 95% CIs come from resampling whole PRs.

| System | Accuracy | Balanced acc. | Resolved recall | Resolved precision | False-resolved rate | Abstained |
|---|---|---|---|---|---|---|
| Always open | 0.0% (0.0%–0.0%) | – | 0.0% | – | – (NaN%–NaN%) | 0.0% |
| Always resolved | 100.0% (100.0%–100.0%) | – | 100.0% | 100.0% | – (NaN%–NaN%) | 0.0% |
| File touched ⇒ resolved | 60.0% (20.0%–100.0%) | – | 60.0% | 100.0% | – (NaN%–NaN%) | 0.0% |
| Lines touched ⇒ resolved | 20.0% (0.0%–60.0%) | – | 20.0% | 100.0% | – (NaN%–NaN%) | 0.0% |

- **Always open**: Never trusts a fix. What you get if the ledger is never updated.
- **Always resolved**: Assumes every push fixes everything (majority class).
- **File touched ⇒ resolved**: Resolved if this push changed the defect's file.
- **Lines touched ⇒ resolved**: Resolved if this push changed lines near the defect.

## By review round (balanced accuracy)

| System | Round 2 (n=2) | Round 3 (n=0) | Round 4 (n=1) | Round 5+ (n=2) |
|---|---|---|---|---|
| Always open | – | – | – | – |
| Always resolved | – | – | – | – |
| File touched ⇒ resolved | – | – | – | – |
| Lines touched ⇒ resolved | – | – | – | – |

## By severity (false-resolved rate: lower is safer)

| System | Blocker/Critical/Major (n=0) | Normal/Minor/Trivial (n=5) |
|---|---|---|
| Always open | – | – |
| Always resolved | – | – |
| File touched ⇒ resolved | – | – |
| Lines touched ⇒ resolved | – | – |

## Caveats

- MCR-bench labels come from an LLM annotation pipeline (3 runs + consistency check), not human review.
- Defect text is the annotator's summary, not the original reviewer comment, and may be cleaner than real review threads.
- This scores state tracking only. It doesn't measure finding new defects (MCR-bench's main precision/recall/F1 task).
