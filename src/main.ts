import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { findSticky, listThreads, pushDiff, upsertSticky } from "./github.js";
import { type AssessInput, decisionState, Judge } from "./jev.js";
import { parseLedger, renderComment, summarize, type RunStats } from "./ledger.js";
import { Verifier } from "./verifier.js";

/** Concurrent model calls per run, to stay well inside API rate limits on PRs with many threads. */
const CONCURRENCY = 4;

async function run() {
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info("Not a pull_request event; nothing to do.");
    return;
  }

  // Secrets aren't passed to workflows triggered from forks. Skip quietly instead of failing the check.
  const apiKey = core.getInput("typesafe-api-key");
  if (!apiKey) {
    core.notice("Retrace skipped: no typesafe-api-key (PRs from forks don't receive repository secrets).");
    return;
  }

  const octokit = getOctokit(core.getInput("github-token", { required: true }));
  const judge = new Judge(
    {
      apiKey,
      baseURL: core.getInput("typesafe-base-url") || undefined,
      model: core.getInput("model") || "jev-latest",
    },
    Number(core.getInput("fixed-threshold") || "0.76"),
    Number(core.getInput("min-confidence") || "0.6"),
  );

  // Optional cascade: Jev filters, an LLM confirms ✅. Thresholds tuned on MCR-bench dev PRs (eval/cascade.ts).
  const verifierModel = core.getInput("verifier-model");
  const anthropicKey = core.getInput("anthropic-api-key");
  const verifier = verifierModel && anthropicKey ? new Verifier(verifierModel, anthropicKey) : undefined;
  if (verifierModel && !anthropicKey) core.warning("verifier-model is set but anthropic-api-key is empty; using Jev alone.");
  const gate = Number(core.getInput("verifier-gate") || "0.74");
  const verifierThreshold = Number(core.getInput("verifier-threshold") || "0.89");

  const { owner, repo } = context.repo;
  const number = pr.number as number;
  const after = (context.payload.after as string | undefined) ?? (pr.head.sha as string);
  const before = context.payload.before as string | undefined;
  const isPush = context.payload.action === "synchronize" && !!before;

  const started = Date.now();
  const sticky = await findSticky(octokit, owner, repo, number);
  const ledger = parseLedger(sticky?.body);
  const threads = (await listThreads(octokit, owner, repo, number)).filter((t) => !t.isResolved);

  // Only a new push ("synchronize") gives us a diff to judge against. Other events just record the threads.
  const push = isPush ? await pushDiff(octokit, owner, repo, before!, after) : undefined;
  if (isPush && !push) {
    core.warning("This push rewrote history (force-push or rebase), so it can't be diffed against the previous head. Statuses are unchanged until the next regular push.");
    return;
  }
  if (!push && threads.length === 0) {
    core.info("No open review threads and no new push yet.");
    return;
  }

  ledger.round += 1;
  const stats: RunStats = { checked: threads.length, skippedDeterministically: 0, jevCalls: 0, tokens: 0, ms: 0 };

  await pool(threads, CONCURRENCY, async (t) => {
    const entry = (ledger.threads[t.id] ??= {
      url: t.url, path: t.path, author: t.author, summary: summarize(t.body), history: [],
    });
    const patch = push?.files.get(t.path);

    // Deterministic first: if the push didn't touch this file, there is nothing for a model to judge.
    if (!patch) {
      stats.skippedDeterministically += 1;
      entry.history.push({ round: ledger.round, sha: after, status: "untouched" });
      return;
    }

    const input: AssessInput = {
      path: t.path,
      reviewComment: t.body,
      codeWhenCommented: t.diffHunk,
      pushFiles: push!.files,
      commitMessages: push!.commitMessages,
    };
    try {
      const a = await judge.assess(input);
      stats.jevCalls += 1;
      stats.tokens += a.tokens;
      let status = a.status;
      let confidence = a.status === "fixed" ? a.pAddressed : a.confidence;

      // Cascade: only threads Jev finds likely-addressed go to the LLM, and ✅ needs both to agree.
      if (verifier) {
        let fixed = false;
        if (a.pAddressed >= gate) {
          try {
            const v = await verifier.verify(decisionState(input));
            fixed = v.pAddressed >= verifierThreshold;
            if (fixed) confidence = Math.min(a.pAddressed, v.pAddressed);
          } catch (err) {
            core.warning(`Verifier failed for ${t.url}; not marking it fixed: ${(err as Error).message}`);
          }
        }
        status = judge.statusFor(a, fixed);
        if (!fixed) confidence = a.confidence;
      }

      entry.history.push({ round: ledger.round, sha: after, status, confidence });
      core.info(`${t.path}: ${status} (addressed p=${a.pAddressed.toFixed(2)}, touched p=${a.pTouched.toFixed(2)})`);
    } catch (err) {
      core.warning(`Jev call failed for ${t.url}: ${(err as Error).message}`);
      entry.history.push({ round: ledger.round, sha: after, status: "unsure" });
    }
  });

  // Threads resolved by humans drop out of the table.
  const open = new Set(threads.map((t) => t.id));
  for (const id of Object.keys(ledger.threads)) if (!open.has(id)) delete ledger.threads[id];

  stats.ms = Date.now() - started;
  const body = renderComment(ledger, after, stats);
  await upsertSticky(octokit, owner, repo, number, sticky?.id, body);
  await core.summary.addRaw(body).write();
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

run().catch((err) => core.setFailed((err as Error).message));
