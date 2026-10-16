// v3: several narrow Jev questions in one call, combined by a small logistic regression trained on dev PRs.
// Goal: high confidence that a thread is really resolved (recall at a strict false-resolved budget).
//
//   npm run v3 -- --split dev     # ask the questions on dev PRs (needed for training)
//   npm run v3 -- --split test    # ask on held-out PRs, then fit on dev and score test once
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { decisionState } from "../src/jev.js";
import { type Case, LANGS, loadCases, splitDiff } from "./mcr.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");
const { values: args } = parseArgs({ options: { split: { type: "string", default: "dev" }, concurrency: { type: "string", default: "8" } } });

// ---------- questions: narrow, positively worded, each answerable on its own ----------

export const V3_QUESTIONS = {
  addressed: {
    type: "noul",
    instructions:
      "After `new_change` is applied, has the concern in `review_comment.reviewer_comment` been addressed? " +
      "Count it as addressed if the change does what the reviewer asked, or handles the concern in another way " +
      "the reviewer would accept, such as documenting the limitation or moving the code somewhere it is fixed.",
    criteria: {
      true: "The concern is addressed by this change.",
      false: "The concern is still present after this change, or only a minor part of it was handled.",
    },
  },
  touched: { type: "noul", instructions: "Does `new_change` modify the code that `review_comment` is about?" },
  still_present: {
    type: "noul",
    instructions: "Looking at the code as it is after `new_change.diff`, is the problem described in `review_comment.reviewer_comment` still there?",
  },
  suggestion_applied: {
    type: "noul",
    instructions: "Does `new_change` make the specific change that `review_comment.reviewer_comment` asks for or suggests?",
  },
  only_partial: {
    type: "noul",
    instructions: "`review_comment.reviewer_comment` may ask for several things. Does `new_change` do some of them but leave at least one undone?",
  },
  commits_mention_review: {
    type: "noul",
    instructions: "Do `new_change.commit_messages` say that review feedback was addressed, applied or fixed?",
  },
  fixed_in_other_file: {
    type: "noul",
    instructions: "Do the diffs in `new_change.other_files_changed` fix the problem described in `review_comment.reviewer_comment`?",
  },
} as const;
type QName = keyof typeof V3_QUESTIONS;
const QNAMES = Object.keys(V3_QUESTIONS) as QName[];

// ---------- ask Jev (cached) ----------

const hash = (s: string) => { let h = 2166136261; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0; return h; };
const isDev = (pr: string) => hash(pr) % 10 < 3; // same split everywhere
const all = loadCases(join(here, "data/MCR-bench/MCR-bench/dataset"), LANGS);
const cachePath = join(RESULTS, "v3.jsonl");
type Ans = { id: string; tokens: number; ms: number } & Record<QName, number>;
const cache = new Map<string, Ans>(
  existsSync(cachePath) ? readFileSync(cachePath, "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }) : [],
);

const want = all.filter((c) => c.patch && (args.split === "dev" ? isDev(c.pr) : !isDev(c.pr)) && !cache.has(c.id));
const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, defaultModel: "jev-latest" });
console.error(`v3/${args.split}: ${want.length} Jev calls (${cache.size} cached)`);
let i = 0, failed = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (i < want.length) {
    const c = want[i++];
    const t0 = Date.now();
    try {
      const { answers, usage } = await client.systemOne({
        state: decisionState({ path: c.file, reviewComment: c.reviewComment, codeWhenCommented: c.codeWhenCommented, pushFiles: splitDiff(c.fullDiff), commitMessages: c.commitMessages }),
        questions: V3_QUESTIONS,
      });
      const a = { id: c.id, tokens: usage.input_tokens ?? 0, ms: Date.now() - t0 } as Ans;
      for (const q of QNAMES) a[q] = answers[q].noul;
      cache.set(c.id, a);
      appendFileSync(cachePath, `${JSON.stringify(a)}\n`);
    } catch (err) {
      if (++failed <= 3) console.error(`  ${c.id}: ${(err as Error).message}`);
    }
  }
}));
if (failed) console.error(`${failed} calls failed (rerun to retry)`);
const devOnly = args.split === "dev";

// ---------- features: Jev probabilities (as log-odds) + facts the Action also has ----------

const logit = (p: number) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };
const REVIEW_WORDS = /\b(review|address|feedback|comment|suggest|nit|pr feedback|fix(ed)?)\b/i;
const FEATURES = [...QNAMES.map((q) => `jev:${q}`), "lines_touched", "file_deleted", "commit_review_words", "round"];
function features(c: Case, a: Ans): number[] {
  return [
    ...QNAMES.map((q) => logit(a[q])),
    c.linesTouched ? 1 : 0,
    /^@@ -\d+(,\d+)? \+0,0 @@/m.test(c.patch ?? "") ? 1 : 0,
    c.commitMessages.some((m) => REVIEW_WORDS.test(m)) ? 1 : 0,
    Math.min(c.round, 6) / 6,
  ];
}

function load0(f: string) { return new Map<string, Record<string, number>>(readFileSync(join(RESULTS, f), "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; })); }

// ---------- logistic regression (L2), fit on dev only ----------

function fit(X: number[][], y: number[], l2: number) {
  const d = X[0].length;
  const mu = Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mu[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < 3000; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    Z.forEach((z, k) => { const p = 1 / (1 + Math.exp(-(b + z.reduce((s, v, j) => s + v * w[j], 0)))); const e = p - y[k]; gb += e; z.forEach((v, j) => (gw[j] += e * v)); });
    for (let j = 0; j < d; j++) w[j] -= 0.5 * (gw[j] / Z.length + l2 * w[j]);
    b -= 0.5 * (gb / Z.length);
  }
  return { predict: (x: number[]) => 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + ((v - mu[j]) / sd[j]) * w[j], 0)))), w, b };
}

const dev = all.filter((c) => isDev(c.pr)), test = all.filter((c) => !isDev(c.pr));
const ok = (c: Case) => !c.patch || cache.has(c.id);
const devCalled = dev.filter((c) => c.patch && cache.has(c.id));
const y01 = (c: Case) => (c.label === "Resolved" ? 1 : 0);

// Choose regularisation by 5-fold cross-validation on dev, grouped by PR, maximising recall at ≤5% false-resolved.
const folds = (c: Case) => hash(`fold:${c.pr}`) % 5;
let best = { l2: 0.01, score: -1 };
for (const l2 of [0.001, 0.01, 0.1, 1]) {
  const oof = new Map<string, number>();
  for (let f = 0; f < 5; f++) {
    const tr = devCalled.filter((c) => folds(c) !== f);
    const m = fit(tr.map((c) => features(c, cache.get(c.id)!)), tr.map(y01), l2);
    for (const c of devCalled.filter((c) => folds(c) === f)) oof.set(c.id, m.predict(features(c, cache.get(c.id)!)));
  }
  const s = recallAt(dev.filter(ok), (c) => (c.patch ? oof.get(c.id)! : 0), 0.05);
  if (s > best.score) best = { l2, score: s };
}
{
  const v2dev = load0("variant-v2.jsonl");
  const devOk = dev.filter((c) => !c.patch || (cache.has(c.id) && v2dev.has(c.id)));
  console.error(`dev, cross-validated: v3 recall @ ≤5% false-resolved = ${(best.score * 100).toFixed(1)}% (L2 ${best.l2}); ` +
    `v2 single question on the same dev cases = ${(recallAt(devOk, (c) => (c.patch ? v2dev.get(c.id)!.p : 0), 0.05) * 100).toFixed(1)}%`);
}
const model = fit(devCalled.map((c) => features(c, cache.get(c.id)!)), devCalled.map(y01), best.l2);
const pV3 = (c: Case) => (c.patch ? model.predict(features(c, cache.get(c.id)!)) : 0);

// Strict threshold chosen on dev (out-of-fold would be cleaner; in-sample on dev is fine for a 13-weight model).
const devScored = dev.filter(ok);
const thr = [...new Set(devScored.map(pV3))].sort((a, b) => a - b).find((t) => t > 0 && rates(devScored, pV3, t).frr <= 0.05) ?? 1;

if (devOnly) process.exit(0);

// ---------- compare on held-out PRs ----------

const load = (f: string) => new Map<string, Record<string, number>>(readFileSync(join(RESULTS, f), "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }));
const jev = load("jev-jev-latest-q2.jsonl"), son = load("llm-claude-sonnet-5-5.jsonl");
const T = test.filter((c) => !c.patch || (cache.has(c.id) && jev.has(c.id) && son.has(c.id)));
const pJev = (c: Case) => (c.patch ? jev.get(c.id)!.pAddressed : 0);
const pSon = (c: Case) => (c.patch ? son.get(c.id)!.pAddressed : 0);

const out: string[] = [];
const emit = (s = "") => out.push(s);
emit("# Retrace v3 (multi-question Jev + learned combiner) vs v2 and Claude Sonnet 5.5");
emit();
emit(`Held-out PRs: ${T.length} cases. Combiner trained on ${devCalled.length} dev cases (L2 = ${best.l2}, picked by 5-fold CV on dev).`);
emit();
emit("**Best-case thresholds on test** (each system gets the threshold that suits it best on the test cases themselves, which flatters all three equally):");
emit();
emit("| System | AUROC | Recall @ ≤5% false-resolved | Precision there | Recall @ ≤2% false-resolved | Cost / 1k checks |");
emit("|---|---|---|---|---|---|");
const v3Tok = T.filter((c) => c.patch).reduce((s, c) => s + cache.get(c.id)!.tokens, 0) / T.filter((c) => c.patch).length;
for (const [name, f, cost] of [["Jev v2 (shipped)", pJev, "$0.06"], ["Claude Sonnet 5.5", pSon, "$4.38"], ["**Jev v3**", pV3, `$${((v3Tok * 0.042) / 1000).toFixed(2)}`]] as const) {
  const t5 = bestThr(T, f, 0.05);
  emit(`| ${name} | ${auroc(T, f).toFixed(3)} | ${pct(recallAt(T, f, 0.05))} | ${pct(rates(T, f, t5).precision)} | ${pct(recallAt(T, f, 0.02))} | ${cost} |`);
}
emit();
const r = rates(T, pV3, thr);
const jv2 = rates(T, pJev, 0.88);
emit("**Honest operating point** (threshold fixed on dev before looking at test):");
emit();
emit("| System | Threshold | Recall | False-resolved | Precision of ✅ |");
emit("|---|---|---|---|---|");
emit(`| Jev v2, strict (0.88, chosen on dev earlier) | 0.88 | ${pct(jv2.recall)} | ${pct(jv2.frr)} | ${pct(jv2.precision)} |`);
emit(`| **Jev v3** | ${thr.toFixed(2)} | ${pct(r.recall)} | ${pct(r.frr)} | ${pct(r.precision)} |`);
emit();
emit("Learned weights (standardised; positive pushes toward resolved):");
emit();
emit(FEATURES.map((f, j) => `\`${f}\` ${model.w[j] >= 0 ? "+" : ""}${model.w[j].toFixed(2)}`).join(" · "));
const report = out.join("\n");
writeFileSync(join(RESULTS, "v3.md"), `${report}\n`);
writeFileSync(join(RESULTS, "v3-test-preds.json"), JSON.stringify(T.map((c) => ({ pr: c.pr, y: c.label === "Resolved" ? 1 : 0, v2: pJev(c), son: pSon(c), v3: pV3(c) }))));
console.log(report);

// ---------- metrics ----------

function rates(cs: Case[], f: (c: Case) => number, t: number) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const c of cs) { const r = f(c) >= t && t > 0; c.label === "Resolved" ? (r ? tp++ : fn++) : r ? fp++ : tn++; }
  return { recall: tp / (tp + fn), frr: fp / (fp + tn), precision: tp / (tp + fp) };
}
function bestThr(cs: Case[], f: (c: Case) => number, budget: number) {
  let bt = 1, br = -1;
  for (const t of [...new Set(cs.map(f))].filter((t) => t > 0)) { const x = rates(cs, f, t); if (x.frr <= budget && x.recall > br) { br = x.recall; bt = t; } }
  return bt;
}
function recallAt(cs: Case[], f: (c: Case) => number, budget: number) { return rates(cs, f, bestThr(cs, f, budget)).recall; }
function auroc(cs: Case[], f: (c: Case) => number) {
  const pos = cs.filter((c) => c.label === "Resolved").map(f), neg = cs.filter((c) => c.label !== "Resolved").map(f).sort((a, b) => a - b);
  let s = 0;
  for (const a of pos) { let lo = 0, hi = neg.length; while (lo < hi) { const m = (lo + hi) >> 1; neg[m] < a ? (lo = m + 1) : (hi = m); } let eq = 0; for (let k = lo; k < neg.length && neg[k] === a; k++) eq++; s += lo + eq / 2; }
  return s / (pos.length * neg.length);
}
function pct(x: number) { return Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`; }
