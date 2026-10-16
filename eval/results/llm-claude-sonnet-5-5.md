# Jev vs claude-sonnet-5-5 on held-out MCR-bench PRs

2190 cases (1656 needing a model call), 70.9% resolved. Both systems get the same state and the same question. Untouched files count as still open for both.

| System | AUROC | Recall @ ≤5% false-resolved | Recall @ ≤12% false-resolved | Brier | At p ≥ 0.5: recall / false-resolved |
|---|---|---|---|---|---|
| Jev (jev-latest) | 0.759 | 37.3% | 51.7% | 0.165 | 67.7% / 25.5% |
| claude-sonnet-5-5 | 0.775 | 37.8% | 60.0% | 0.168 | 69.9% / 24.8% |

Recall @ budget picks the best threshold on these same cases for each system: optimistic for both, but equally so.

| System | Cost per 1,000 checks | Median latency | p95 latency | Avg input / output tokens |
|---|---|---|---|---|
| Jev | $0.062 | 215 ms | 265 ms | 1477 / 0 |
| claude-sonnet-5-5 | $4.379 | 1669 ms | 2975 ms | 2063 / 25 |

This run: 1656 claude-sonnet-5-5 calls ≈ $7.25. Latencies were measured at concurrency 8 from this machine; the Jev latencies come from the earlier full run.
