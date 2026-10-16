// v4: same two questions as the shipped v2, with more context from the papers, one signal at a time.
//   desc  PR title + description (ContextCRBench: intent beats extra code)
//   hist  this file's earlier pushes since the comment (MCR-Bench / History Matters: cross-round memory)
//   disc  review discussion since the comment, before this push (History Matters: review interactions)
//   all   all three
// Plus "ens": average log-odds of v2 and the variants (SWRBench: aggregating independent judgments).
//
//   npm run v4 -- --variants desc,hist,disc,all --split dev
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ContentValue, TypeSafeClient } from "@typesafe-ai/sdk";
import { anchorLines, relevantHunks } from "../src/diff.js";
import { decisionState, QUESTIONS } from "../src/jev.js";
import { type Case, LANGS, loadCases, splitDiff } from "./mcr.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");
const { values: args } = parseArgs({
  options: { variants: { type: "string", default: "desc,hist,disc,all" }, split: { type: "string", default: "dev" }, concurrency: { type: "string", default: "8" } },
});
const VARIANTS = args.variants!.split(",");
const ask = { touched: QUESTIONS.touched, addressed: QUESTIONS.addressed };

function state(c: Case, v: string): Record<string, ContentValue> {
  const s = decisionState({ path: c.file, reviewComment: c.reviewComment, codeWhenCommented: c.codeWhenCommented, pushFiles: splitDiff(c.fullDiff), commitMessages: c.commitMessages }) as Record<string, ContentValue>;
  const use = (x: string) => v === x || v === "all";
  if (use("desc")) s.pull_request = { title: c.prTitle, description: c.prDescription.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim().slice(0, 1200) };
  if (use("hist") && c.earlierDiffs.length) {
    (s.new_change as Record<string, ContentValue>).earlier_changes_to_file_since_comment = relevantHunks(c.earlierDiffs.join("\n"), anchorLines(c.codeWhenCommented), 2000);
  }
  if (use("disc") && c.discussion.length) {
    const recent: string[] = [];
    let used = 0;
    for (const d of [...c.discussion].reverse()) { if (used + d.length > 1500) break; recent.unshift(d); used += d.length; }
    s.review_discussion_before_push = recent;
  }
  return s;
}

const hash = (s: string) => { let h = 2166136261; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0; return h; };
const isDev = (pr: string) => hash(pr) % 10 < 3;
const cases = loadCases(join(here, "data/MCR-bench/MCR-bench/dataset"), LANGS).filter((c) => (args.split === "dev" ? isDev(c.pr) : !isDev(c.pr)));
const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, defaultModel: "jev-latest" });

const caches = new Map<string, Map<string, { p: number; tokens: number }>>();
for (const v of VARIANTS) {
  const path = join(RESULTS, `v4-${v}.jsonl`);
  const cache = new Map<string, { p: number; tokens: number }>(existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }) : []);
  caches.set(v, cache);
  const todo = cases.filter((c) => c.patch && !cache.has(c.id));
  console.error(`v4-${v}/${args.split}: ${todo.length} calls (${cache.size} cached)`);
  let i = 0, failed = 0;
  await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
    while (i < todo.length) {
      const c = todo[i++];
      try {
        const { answers, usage } = await client.systemOne({ state: state(c, v), questions: ask });
        const a = { id: c.id, p: answers.addressed.noul, pTouched: answers.touched.noul, tokens: usage.input_tokens ?? 0 };
        cache.set(c.id, a);
        appendFileSync(path, `${JSON.stringify(a)}\n`);
      } catch (err) { if (++failed <= 3) console.error(`  ${c.id}: ${(err as Error).message}`); }
    }
  }));
  if (failed) console.error(`  ${failed} failed (rerun to retry)`);
}

// ---------- compare against v2 on the same cases ----------

const v2 = new Map<string, { p: number; tokens: number }>(
  readFileSync(join(RESULTS, args.split === "dev" ? "variant-v2.jsonl" : "jev-jev-latest-q2.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => { const a = JSON.parse(l); return [a.id, { p: a.p ?? a.pAddressed, tokens: a.tokens }]; }),
);
const all = [["v2", v2] as const, ...VARIANTS.map((v) => [v, caches.get(v)!] as const)];
const scored = cases.filter((c) => !c.patch || all.every(([, m]) => m.has(c.id)));
const logit = (p: number) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };
const ens = (c: Case) => { if (!c.patch) return 0; const ls = all.map(([, m]) => logit(m.get(c.id)!.p)); return 1 / (1 + Math.exp(-ls.reduce((a, b) => a + b, 0) / ls.length)); };

console.log(`\n${args.split} split: ${scored.length} cases (${scored.filter((c) => c.patch).length} with a Jev call), ${pct(scored.filter((c) => c.label === "Resolved").length / scored.length)} resolved\n`);
console.log("| Variant | AUROC | Recall @ ≤2% | Recall @ ≤5% | Recall @ ≤12% | Avg tokens |");
console.log("|---|---|---|---|---|---|");
const rows: [string, (c: Case) => number, number][] = [
  ...all.map(([name, m]) => [name, (c: Case) => (c.patch ? m.get(c.id)!.p : 0), avgTok(m)] as [string, (c: Case) => number, number]),
  ["ens (mean log-odds of all above)", ens, Number.NaN],
];
for (const [name, f, tok] of rows) {
  console.log(`| ${name} | ${auroc(scored, f).toFixed(3)} | ${pct(recallAt(scored, f, 0.02))} | ${pct(recallAt(scored, f, 0.05))} | ${pct(recallAt(scored, f, 0.12))} | ${Number.isNaN(tok) ? "–" : Math.round(tok)} |`);
}
console.log("\nOn dev, thresholds are each system's best on these cases: fine for choosing, not for reporting.");

function avgTok(m: Map<string, { tokens: number }>) { const xs = scored.filter((c) => c.patch).map((c) => m.get(c.id)!.tokens); return xs.reduce((a, b) => a + b, 0) / xs.length; }
function rates(cs: Case[], f: (c: Case) => number, t: number) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const c of cs) { const r = t > 0 && f(c) >= t; c.label === "Resolved" ? (r ? tp++ : fn++) : r ? fp++ : tn++; }
  return { recall: tp / (tp + fn), frr: fp / (fp + tn) };
}
function recallAt(cs: Case[], f: (c: Case) => number, budget: number) {
  let best = 0;
  for (const t of [...new Set(cs.map(f))].filter((t) => t > 0)) { const r = rates(cs, f, t); if (r.frr <= budget) best = Math.max(best, r.recall); }
  return best;
}
function auroc(cs: Case[], f: (c: Case) => number) {
  const pos = cs.filter((c) => c.label === "Resolved").map(f), neg = cs.filter((c) => c.label !== "Resolved").map(f).sort((a, b) => a - b);
  let s = 0;
  for (const a of pos) { let lo = 0, hi = neg.length; while (lo < hi) { const m = (lo + hi) >> 1; neg[m] < a ? (lo = m + 1) : (hi = m); } let eq = 0; for (let k = lo; k < neg.length && neg[k] === a; k++) eq++; s += lo + eq / 2; }
  return s / (pos.length * neg.length);
}
function pct(x: number) { return Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`; }
