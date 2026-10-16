# Cascade: Jev filters, claude-sonnet-5-5 confirms

Held-out PRs: 2190 cases. All thresholds tuned on 941 dev cases, then applied unchanged.

## Target ≤5% false-resolved (on dev)

| System | Thresholds | Recall | False-resolved | Precision of ✅ | Cost / 1k checks |
|---|---|---|---|---|---|
| Jev only | ≥0.88 | 41.9% | 6.3% | 94.2% | $0.06 |
| claude-sonnet-5-5 only | ≥0.91 | 49.5% | 5.6% | 95.5% | $4.38 |
| **Cascade** | Jev ≥0.74, then claude-sonnet-5-5 ≥0.89 | 49.7% | 6.3% | 95.1% | $2.68 (LLM on 59.8% of checks) |

95% CIs (PR bootstrap): claude-sonnet-5-5 − Jev recall [5.9, 9.5] pts; cascade − claude-sonnet-5-5 recall [-1.0, 1.5] pts, false-resolved [-0.3, 1.6] pts.

## Target ≤3% false-resolved (on dev)

| System | Thresholds | Recall | False-resolved | Precision of ✅ | Cost / 1k checks |
|---|---|---|---|---|---|
| Jev only | ≥0.92 | 30.9% | 2.2% | 97.2% | $0.06 |
| claude-sonnet-5-5 only | ≥0.94 | 37.8% | 2.5% | 97.3% | $4.38 |
| **Cascade** | Jev ≥0.82, then claude-sonnet-5-5 ≥0.91 | 43.4% | 4.1% | 96.3% | $2.27 (LLM on 50.4% of checks) |

95% CIs (PR bootstrap): claude-sonnet-5-5 − Jev recall [4.9, 8.9] pts; cascade − claude-sonnet-5-5 recall [4.0, 7.2] pts, false-resolved [0.4, 3.0] pts.
