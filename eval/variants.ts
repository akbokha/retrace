// Compares question variants against the shipped one (v0), on a split of PRs.
// Pick a winner on --split dev, then confirm it once on --split test.
//
//   npm run variants -- --variant v1 --split dev
//   npm run variants -- --variant v2 --split test
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ContentValue, TypeSafeClient } from "@typesafe-ai/sdk";
import { anchorLines, otherFiles, relevantHunks } from "../src/diff.js";
import { type Case, LANGS, loadCases, splitDiff } from "./mcr.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");
const { values: args } = parseArgs({
  options: {
    variant: { type: "string", default: "v1" },
    split: { type: "string", default: "dev" },
    concurrency: { type: "string", default: "8" },
  },
});

const TOUCHED = {
  type: "noul",
  instructions: "Does `new_change` modify the code that `review_comment` is about?",
} as const;

const ADDRESSED = {
  type: "noul",
  instructions:
    "After `new_change` is applied, has the concern in `review_comment.reviewer_comment` been addressed? " +
    "Count it as addressed if the change does what the reviewer asked, or handles the concern in another way " +
    "the reviewer would accept, such as documenting the limitation or moving the code somewhere it is fixed.",
  criteria: {
    true: "The concern is addressed by this change.",
    false: "The concern is still present after this change, or only a minor part of it was handled.",
  },
} as const;


function request(c: Case): { state: Record<string, ContentValue>; questions: { touched: typeof TOUCHED; addressed: typeof ADDRESSED } } {
  const anchors = anchorLines(c.codeWhenCommented);
  const review_comment = { file: c.file, reviewer_comment: c.reviewComment, code_when_commented: c.codeWhenCommented };
  if (args.variant === "v1") {
    return { state: { review_comment, new_change: { file: c.file, diff: relevantHunks(c.patch!, anchors) } }, questions: { touched: TOUCHED, addressed: ADDRESSED } };
  }
  return {
    state: {
      review_comment,
      new_change: {
        file: c.file,
        diff: relevantHunks(c.patch!, anchors, 4500),
        commit_messages: c.commitMessages.map((m) => m.slice(0, 200)).slice(0, 8),
        other_files_changed: otherFiles(splitDiff(c.fullDiff), c.file, anchors),
      },
    },
    questions: { touched: TOUCHED, addressed: ADDRESSED },
  };
}

// ---------- run ----------

const isDev = (pr: string) => hash(pr) % 10 < 3; // same split as eval/run.ts
const cases = loadCases(join(here, "data/MCR-bench/MCR-bench/dataset"), LANGS)
  .filter((c) => (args.split === "dev" ? isDev(c.pr) : !isDev(c.pr)));
const cachePath = join(RESULTS, `variant-${args.variant}.jsonl`);
const cache = new Map<string, { p: number; tokens: number }>(
  existsSync(cachePath) ? readFileSync(cachePath, "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }) : [],
);
const v0 = new Map<string, { status: string; pTouched: number; outcomeProbs: Record<string, number> }>(
  readFileSync(join(RESULTS, "jev-jev-latest.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }),
);

const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, defaultModel: "jev-latest" });
const todo = cases.filter((c) => c.patch && !cache.has(c.id));
console.error(`${args.variant}/${args.split}: ${todo.length} calls (${cache.size} cached)`);
let i = 0, failed = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (i < todo.length) {
    const c = todo[i++];
    try {
      const { answers, usage } = await client.systemOne(request(c));
      const a = { id: c.id, p: answers.addressed.noul, pTouched: answers.touched.noul, tokens: usage.input_tokens ?? 0 };
      cache.set(c.id, a);
      appendFileSync(cachePath, `${JSON.stringify(a)}\n`);
    } catch (err) {
      if (++failed <= 3) console.error(`  ${c.id}: ${(err as Error).message}`);
    }
  }
}));

// ---------- compare ----------

const scored = cases.filter((c) => !c.patch || (cache.has(c.id) && v0.has(c.id)));
const y = scored.map((c) => (c.label === "Resolved" ? 1 : 0));
// Untouched files are "still open" with p = 0 in every variant (same file filter as the Action).
const pV0 = scored.map((c) => { const a = v0.get(c.id); return c.patch && a ? a.pTouched * (a.outcomeProbs.fixed ?? 0) : 0; });
const pNew = scored.map((c) => (c.patch ? cache.get(c.id)!.p : 0));
const shippedV0 = scored.map((c) => (c.patch ? v0.get(c.id)?.status === "fixed" : false));

console.log(`\n${args.split} split: ${scored.length} cases, ${pct(y.filter(Boolean).length / y.length)} resolved\n`);
console.log("| Variant | AUROC | Recall @ FRR ≤ 5% | Recall @ FRR ≤ 12% | Brier | Rule: p ≥ 0.5 (recall / FRR / bal. acc.) |");
console.log("|---|---|---|---|---|---|");
for (const [name, p] of [["v0 (shipped: 4-way choice)", pV0], [`${args.variant}`, pNew]] as const) {
  const r = at(p, 0.5);
  console.log(`| ${name} | ${auroc(p).toFixed(3)} | ${pct(recallAt(p, 0.05))} | ${pct(recallAt(p, 0.12))} | ${brier(p).toFixed(3)} | ${pct(r.recall)} / ${pct(r.frr)} / ${pct((r.recall + 1 - r.frr) / 2)} |`);
}
const s0 = rates(shippedV0);
console.log(`\nv0 as shipped (only \`fixed\` counts, unsure stays open): recall ${pct(s0.recall)}, FRR ${pct(s0.frr)}, balanced acc. ${pct((s0.recall + 1 - s0.frr) / 2)}`);
const tok = scored.reduce((s, c) => s + (cache.get(c.id)?.tokens ?? 0), 0);
console.log(`${args.variant}: ${tok.toLocaleString("en-US")} input tokens (≈ $${(tok * 0.042e-6).toFixed(4)})${failed ? `, ${failed} failed calls` : ""}`);

// ---------- metrics ----------

function rates(pred: boolean[]) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  pred.forEach((r, k) => (y[k] ? (r ? tp++ : fn++) : r ? fp++ : tn++));
  return { recall: tp / (tp + fn), frr: fp / (fp + tn) };
}
function at(p: number[], t: number) { return rates(p.map((v) => v >= t)); }
/** Best recall over thresholds whose false-resolved rate stays within budget. */
function recallAt(p: number[], budget: number) {
  let best = 0;
  for (const t of [...new Set(p)].sort((a, b) => a - b)) { const r = at(p, t); if (r.frr <= budget && t > 0) best = Math.max(best, r.recall); }
  return best;
}
function auroc(p: number[]) {
  const pos = p.filter((_, k) => y[k]), neg = p.filter((_, k) => !y[k]);
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
function brier(p: number[]) { return p.reduce((s, v, k) => s + (v - y[k]) ** 2, 0) / p.length; }
function pct(x: number) { return Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`; }
function hash(s: string) { let h = 2166136261; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0; return h; }
