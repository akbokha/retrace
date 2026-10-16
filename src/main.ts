import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { anchorLines, relevantHunks } from "./diff.js";
import { findSticky, listThreads, pushDiff, upsertSticky } from "./github.js";
import { Judge } from "./jev.js";
import { parseLedger, renderComment, summarize, type RunStats } from "./ledger.js";

async function run() {
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info("Not a pull_request event; nothing to do.");
    return;
  }

  const octokit = getOctokit(core.getInput("github-token", { required: true }));
  const judge = new Judge(
    {
      apiKey: core.getInput("typesafe-api-key", { required: true }),
      baseURL: core.getInput("typesafe-base-url") || undefined,
      model: core.getInput("model") || "jev-latest",
    },
    Number(core.getInput("min-confidence") || "0.6"),
  );

  const { owner, repo } = context.repo;
  const number = pr.number as number;
  const after = (context.payload.after as string | undefined) ?? (pr.head.sha as string);
  const before = context.payload.before as string | undefined;

  const started = Date.now();
  const sticky = await findSticky(octokit, owner, repo, number);
  const ledger = parseLedger(sticky?.body);
  const threads = (await listThreads(octokit, owner, repo, number)).filter((t) => !t.isResolved);

  // Only a new push ("synchronize") gives us a diff to judge against. Other events just record the threads.
  const diff = context.payload.action === "synchronize" && before ? await pushDiff(octokit, owner, repo, before, after) : undefined;
  if (!diff && threads.length === 0) {
    core.info("No open review threads and no new push yet.");
    return;
  }

  ledger.round += 1;
  const stats: RunStats = { checked: threads.length, skippedDeterministically: 0, jevCalls: 0, tokens: 0, ms: 0 };

  await Promise.all(threads.map(async (t) => {
    const entry = (ledger.threads[t.id] ??= {
      url: t.url, path: t.path, author: t.author, summary: summarize(t.body), history: [],
    });
    const patch = diff?.get(t.path);

    // Deterministic first: if the push didn't touch this file, there is nothing for a model to judge.
    if (!patch) {
      stats.skippedDeterministically += 1;
      entry.history.push({ round: ledger.round, sha: after, status: "untouched" });
      return;
    }

    try {
      const a = await judge.assess({
        path: t.path,
        reviewComment: t.body,
        codeWhenCommented: t.diffHunk,
        newDiff: relevantHunks(patch, anchorLines(t.diffHunk)),
      });
      stats.jevCalls += 1;
      stats.tokens += a.tokens;
      entry.history.push({ round: ledger.round, sha: after, status: a.status, confidence: a.confidence });
      core.info(`${t.path}: ${a.status} (touched p=${a.pTouched.toFixed(2)}, conf=${a.confidence.toFixed(2)})`);
    } catch (err) {
      core.warning(`Jev call failed for ${t.url}: ${(err as Error).message}`);
      entry.history.push({ round: ledger.round, sha: after, status: "unsure" });
    }
  }));

  // Threads resolved by humans drop out of the table.
  const open = new Set(threads.map((t) => t.id));
  for (const id of Object.keys(ledger.threads)) if (!open.has(id)) delete ledger.threads[id];

  stats.ms = Date.now() - started;
  const body = renderComment(ledger, after, stats);
  await upsertSticky(octokit, owner, repo, number, sticky?.id, body);
  await core.summary.addRaw(body).write();
}

run().catch((err) => core.setFailed((err as Error).message));
