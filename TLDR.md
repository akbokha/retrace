# Retrace: TL;DR

**Tracking AI and human review comments across PR rounds with a cheap decision model (Jev)**
Repo: [github.com/akbokha/retrace](https://github.com/akbokha/retrace) · Live demo: [PR #1](https://github.com/akbokha/retrace/pull/1) · October 2026

---

## Motivation

Most review work happens in multi-round PRs: comment, fix, re-review, repeat. AI reviewers handle a single round reasonably well but lose track across rounds:

- **Re-flagging fixed code** (temporal misalignment): the largest source of false positives in MCR-Bench.
- **Forgetting open issues** (cross-round forgetting): the largest source of false negatives, especially fixes that arrive in pieces.
- Performance **degrades as rounds increase** (F1 drops 10–30% from round 2 to round 10 for most models).

The question I wanted to answer: *can we keep track of which review comments are actually resolved, cheaply enough to run on every push, without giving up accuracy?*

## What we've done

1. **Built Retrace**, a GitHub Action. On every push it re-checks each open review thread (from humans or any bot) and marks it ✅ fixed / 🟡 partially fixed / 🔴 still open / ⚠️ made worse / ⏸️ not touched. It keeps a per-thread history in one PR comment, with no server or database.
2. **Used Jev for the judgments.** Jev is a decision model that returns calibrated probabilities instead of text (~200 ms, $0.042 per million input tokens). It's skipped entirely when a push doesn't touch the commented file.
3. **Evaluated it on MCR-Bench:** 558 real PRs with labelled defect states per round, giving **3,131 "was this open defect resolved by this push?" cases**. Tuning used only a 30% dev split of PRs; claims come from the 70% held-out split.
4. **Improved it in steps, each checked on held-out PRs:** better questions and context (commit messages, related files), several narrow questions, and context from the papers (PR description, history, discussion).
5. **Compared it with an LLM** (Claude Sonnet 5.5, same input and question), and built a **cascade**: Jev filters, the LLM confirms every ✅.
6. **Shipped and demoed it:** tests, CI, fork and force-push handling, and a live 3-round demo PR.

## Findings

**Retrace vs simple heuristics** (all 3,131 cases):

| | False "fixed" rate | Precision of ✅ |
|---|---|---|
| "File changed ⇒ fixed" | 62.0% | 77.1% |
| "Commented lines changed ⇒ fixed" | 44.9% | 78.4% |
| **Retrace (Jev)** | **13.6%** | **91.3%** |

**Jev vs LLM vs cascade** (held-out PRs; thresholds tuned on dev for ≤5% false "fixed", applied unchanged):

| | Fixes recognised | False "fixed" | Precision of ✅ | Cost / 1,000 checks | Median latency |
|---|---|---|---|---|---|
| Jev alone | 41.9% | 6.3% | 94.2% | **$0.06** | **215 ms** |
| Claude Sonnet 5.5 alone | 49.5% | 5.6% | 95.5% | $4.38 | 1,669 ms |
| **Cascade (Jev → Sonnet)** | **49.7%** | 6.3% | 95.1% | **$2.68** | 215 ms for the 40% Jev filters out |

**Takeaways:**

- **Sonnet is more accurate than Jev alone** at strict settings: 6–9 points more recall (95% CI [5.9, 9.5]). Jev's advantage is cost (~70× cheaper) and speed (~8× faster).
- **The cascade gets Sonnet's accuracy for ~40% less.** The difference from Sonnet alone is within noise (recall CI [−1.0, +1.5] pts). This is the most practical result.
- **What helped Jev:** commit messages plus related changed files (+4 pts recall on held-out PRs). Asking whether the problem is *still present* was a stronger signal than asking whether it was *addressed*.
- **What didn't:** adding the PR description, earlier pushes or the review discussion (as the papers recommend) left ranking quality unchanged (dev AUROC 0.748–0.752 vs 0.750).
- **The benchmark has limits:** in a hand-check of 30 apparent misses, 43% had no fix in that push at all (label noise), 20% were fixed in another file, and 23% were real misses. Measured recall understates real performance.
- **A correction worth knowing:** an earlier comparison called Jev and Sonnet "tied". It used thresholds picked on the test data. The dev-tuned numbers above are the correct ones.
- **Total API cost of all experiments: about $12.**

## Demo

[PR #1](https://github.com/akbokha/retrace/pull/1): a checkout module with three bugs, three review comments, and three pushes, with the cascade on:

| Review comment | Push 1 | Push 2 | Push 3 |
|---|---|---|---|
| Loop off-by-one | ✅ fixed | ✅ | ⏸️ |
| Discount as % + round to cents | 🟡 partial (no rounding) | ✅ fixed | ⏸️ |
| Double-charge race: idempotency key + unique constraint | ⏸️ not touched | 🟡 partial (key only) | ✅ fixed (partly in `schema.sql`) |

All nine judgments were correct. That includes fixes arriving in pieces across pushes, and a fix that spanned two files. Each round took ~2.5 s and a few cents. (A staged demo shows the system works end to end; the evidence is the benchmark above.)

## Limitations and next steps

- Not yet run on real team PRs. A **shadow-mode trial** (log what Retrace would say next to the existing bot) is the natural next step, subject to approval for sending code to external APIs. Kev, an open-source Jev-compatible model, can be self-hosted.
- Hand-label ~100–150 cases, so the strict end of the evaluation isn't dominated by label noise.
- Use thread replies ("done in abc123") as context. MCR-Bench can't evaluate this, so it needs real PR data.

## Resources

- **Code and full write-up:** [github.com/akbokha/retrace](https://github.com/akbokha/retrace). Detailed findings in [`eval/results/findings.md`](https://github.com/akbokha/retrace/blob/main/eval/results/findings.md). Every number here can be reproduced with the `npm run` scripts in the README.
- **Dataset:** [MCR-Bench](https://github.com/DeepSoftwareAnalytics/MCR-bench) (Apache-2.0).
- **Jev** by TypeSafe AI: [typesafe.ai](https://typesafe.ai). TypeScript SDK `@typesafe-ai/sdk`.
- **Kev** (open-source, Jev-compatible API, self-hostable): [github.com/jaredpalmer/kev](https://github.com/jaredpalmer/kev).
- **LLM baseline:** Claude Sonnet 5.5 via the Anthropic API (thinking off, structured output).

## Papers

- **Zheng et al., *From Static to Dynamic: Benchmarking Real-World Code Review with MCR-Bench*** (2026). [arXiv:2608.27442](https://arxiv.org/abs/2608.27442). The problem framing and the dataset: multi-round review, defect state tracking, cross-round failure modes.
- **Kumar, *SWE-PRBench: Benchmarking AI Code Review Quality Against Pull Request Feedback*** (2026). [arXiv:2603.26130](https://arxiv.org/abs/2603.26130). More raw context makes reviewers worse, while small structured context helps. This shaped Retrace's compact input.
- **Hu et al., *Benchmarking LLMs for Fine-Grained Code Review with Enriched Context in Practice* (ContextCRBench)** (2025). [arXiv:2511.07017](https://arxiv.org/abs/2511.07017). PR and issue descriptions help quality assessment more than code context. We tested this for Jev; it didn't carry over.
- **Zeng et al., *Benchmarking and Studying the LLM-based Code Review* (SWRBench)** (2025). [ResearchGate](https://www.researchgate.net/publication/395213467_Benchmarking_and_Studying_the_LLM-based_Code_Review). Aggregating multiple reviews improves results. This motivated the ensemble and cascade experiments.
- ***History Matters: Automatically Estimating Code Quality in Multi-round Reviews via Context-Aware Prompt-Tuning*** (2026). [Zenodo](https://zenodo.org/records/22291142) (venue not verified). Review history helps detect incomplete fixes. This motivated the history and discussion experiments.
