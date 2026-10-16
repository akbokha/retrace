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
           └─ file changed ──► pick only the hunks near the commented lines
                               ──► Jev (one call, two typed questions):
                                     touched:  noul   "does this diff modify the commented code?"
                                     outcome:  choice fixed | partially_fixed | not_addressed | made_worse
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

## Roadmap

- [ ] Evaluation harness: replay MCR-Bench and plot per-round F1 against a stateless reviewer
- [ ] Calibrated thresholds (conformal risk control) for a guaranteed recall target on "still open"
- [ ] Classify developer replies ("done", "won't fix", disputes) and verify "done" claims
- [ ] Deduplicate new bot comments against the ledger before posting
- [ ] Escalate only ⚠️/🟡/❔ threads to an LLM reviewer for targeted re-review

## License

MIT
