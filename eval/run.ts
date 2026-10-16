// Replays MCR-bench round by round and scores how well each system tracks defect state.
//
//   ./eval/fetch-data.sh
//   npm run eval                                   # baselines only, no API key needed
//   TYPESAFE_API_KEY=sk-... npm run eval -- --jev  # + Retrace (Jev); answers are cached, so reruns are free
//   ... --jev --jev-all                            # also ask Jev when the defect's file wasn't touched
//
// Options: --langs py,ts  --limit 200  --concurrency 4
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { anchorLines, relevantHunks } from "../src/diff.js";
import { Judge } from "../src/jev.js";
import { type Case, LANGS, type Lang, loadCases } from "./mcr.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "data/MCR-bench/MCR-bench/dataset");
const RESULTS = join(here, "results");
const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

const { values: args } = parseArgs({
  options: {
    jev: { type: "boolean", default: false },
    "jev-all": { type: "boolean", default: false },
    langs: { type: "string", default: LANGS.join(",") },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    model: { type: "string", default: process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest" },
  },
});

/** A system's verdict for one case. `p` is its probability that the defect is resolved, when it has one. */
interface Pred { resolved: boolean; p?: number; abstained?: boolean }
type System = { name: string; note: string; predict: (c: Case) => Pred };

interface JevAnswer {
  id: string; status: string; pTouched: number; confidence: number;
  outcomeProbs: Record<string, number>; tokens: number; ms: number;
}

// ---------- data ----------

if (!existsSync(DATA)) {
  console.error("Dataset missing. Run ./eval/fetch-data.sh first.");
  process.exit(1);
}
let cases = loadCases(DATA, args.langs!.split(",") as Lang[]);
// Deterministic sample, so runs with --limit are comparable.
cases.sort((a, b) => hash(a.id) - hash(b.id));
if (args.limit) cases = cases.slice(0, Number(args.limit));

// ---------- Jev (cached) ----------

mkdirSync(RESULTS, { recursive: true });
const cachePath = join(RESULTS, `jev-${args.model}.jsonl`);
const cache = new Map<string, JevAnswer>(
  existsSync(cachePath)
    ? readFileSync(cachePath, "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l) as JevAnswer; return [a.id, a]; })
    : [],
);

if (args.jev) {
  const judge = new Judge({ apiKey: process.env.TYPESAFE_API_KEY ?? "", baseURL: process.env.TYPESAFE_BASE_URL, model: args.model! }, 0.6);
  // Retrace only calls Jev when the push touched the file. --jev-all also asks about the rest, with the whole push diff.
  const todo = [
    ...cases.filter((c) => c.patch && !cache.has(c.id)).map((c) => ({ c, key: c.id, diff: c.patch! })),
    ...(args["jev-all"] ? cases.filter((c) => !c.patch && !cache.has(`${c.id}:full`)).map((c) => ({ c, key: `${c.id}:full`, diff: c.fullDiff })) : []),
  ];
  console.error(`Jev: ${todo.length} calls to make (${cache.size} cached)`);
  let done = 0, failed = 0;
  await pool(todo, Number(args.concurrency), async ({ c, key, diff }) => {
    const t0 = Date.now();
    try {
      const a = await judge.assess({
        path: c.file,
        reviewComment: c.reviewComment,
        codeWhenCommented: c.codeWhenCommented,
        newDiff: relevantHunks(diff, anchorLines(c.codeWhenCommented)),
      });
      const ans: JevAnswer = { id: key, status: a.status, pTouched: a.pTouched, confidence: a.confidence, outcomeProbs: a.outcomeProbs, tokens: a.tokens, ms: Date.now() - t0 };
      cache.set(key, ans);
      appendFileSync(cachePath, `${JSON.stringify(ans)}\n`);
    } catch (err) {
      failed++;
      if (failed <= 3) console.error(`  ${c.id}: ${(err as Error).message}`);
    }
    if (++done % 50 === 0) console.error(`  ${done}/${todo.length}`);
  });
  if (failed) console.error(`Jev: ${failed} calls failed (rerun to retry them)`);
}

// ---------- systems ----------

const systems: System[] = [
  { name: "Always open", note: "Never trusts a fix. What you get if the ledger is never updated.", predict: () => ({ resolved: false }) },
  { name: "Always resolved", note: "Assumes every push fixes everything (majority class).", predict: () => ({ resolved: true }) },
  { name: "File touched ⇒ resolved", note: "Resolved if this push changed the defect's file.", predict: (c) => ({ resolved: !!c.patch }) },
  { name: "Lines touched ⇒ resolved", note: "Resolved if this push changed lines near the defect.", predict: (c) => ({ resolved: c.linesTouched }) },
];

const jevCoverage = cases.filter((c) => !c.patch || cache.has(c.id)).length;
if (cache.size > 0) {
  const retrace = (c: Case): Pred => {
    if (!c.patch) return { resolved: false, p: 0 }; // deterministic skip: file untouched => still open
    const a = cache.get(c.id);
    if (!a) return { resolved: false, abstained: true };
    const pFixed = a.pTouched * (a.outcomeProbs.fixed ?? 0);
    return { resolved: a.status === "fixed", p: pFixed, abstained: a.status === "unsure" };
  };
  systems.push({ name: "Retrace (Jev)", note: "File filter + Jev; only `fixed` counts as resolved, `unsure` stays open.", predict: retrace });

  if ([...cache.keys()].some((k) => k.endsWith(":full"))) {
    systems.push({
      name: "Retrace (Jev, no file filter)",
      note: "Also asks Jev when the defect's file wasn't touched, with the whole push diff. More calls; catches fixes made elsewhere.",
      predict: (c) => {
        if (c.patch) return retrace(c);
        const a = cache.get(`${c.id}:full`);
        if (!a) return { resolved: false, abstained: true };
        return { resolved: a.status === "fixed", p: a.pTouched * (a.outcomeProbs.fixed ?? 0), abstained: a.status === "unsure" };
      },
    });
  }
}

// ---------- metrics ----------

interface Metrics { n: number; acc: number; balAcc: number; resolvedRecall: number; resolvedPrecision: number; falseResolved: number; abstain: number }

function score(cs: Case[], preds: Map<string, Pred>): Metrics {
  let tp = 0, fp = 0, tn = 0, fn = 0, ab = 0;
  for (const c of cs) {
    const p = preds.get(c.id)!;
    if (p.abstained) ab++;
    if (c.label === "Resolved") p.resolved ? tp++ : fn++;
    else p.resolved ? fp++ : tn++;
  }
  const div = (a: number, b: number) => (b ? a / b : Number.NaN);
  const rec = div(tp, tp + fn), spec = div(tn, tn + fp);
  return {
    n: cs.length,
    acc: div(tp + tn, cs.length),
    balAcc: (rec + spec) / 2,
    resolvedRecall: rec,
    resolvedPrecision: div(tp, tp + fp),
    falseResolved: div(fp, fp + tn),
    abstain: div(ab, cs.length),
  };
}

/** 95% CI by resampling whole PRs, since rounds of one PR are correlated. */
function bootstrap(cs: Case[], preds: Map<string, Pred>, metric: keyof Metrics, iters = 1000): [number, number] {
  const byPr = new Map<string, Case[]>();
  for (const c of cs) byPr.set(c.pr, [...(byPr.get(c.pr) ?? []), c]);
  const groups = [...byPr.values()];
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const vals: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample = Array.from({ length: groups.length }, () => groups[Math.floor(rand() * groups.length)]).flat();
    const v = score(sample, preds)[metric];
    if (!Number.isNaN(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.floor(vals.length * 0.975)]];
}

// ---------- report ----------

const pct = (x: number) => (Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);
const ci = (r: [number, number]) => `${pct(r[0])}–${pct(r[1])}`;
const out: string[] = [];
const emit = (s = "") => out.push(s);

const nResolved = cases.filter((c) => c.label === "Resolved").length;
const nPrs = new Set(cases.map((c) => c.pr)).size;
emit("# Retrace on MCR-bench: defect state tracking");
emit();
emit(`Task: a defect was raised in an earlier review round. After the next push, is it **Resolved** or still **Open**? ` +
  `${cases.length} cases from ${nPrs} PRs (${args.langs}); ${pct(nResolved / cases.length)} resolved. ` +
  `The push touched the defect's file in ${pct(cases.filter((c) => c.patch).length / cases.length)} of cases.`);
emit();
emit("**False-resolved rate** is the share of still-open defects a system wrongly calls fixed: the \"forgetting\" failure. " +
  "**Resolved recall** is the share of real fixes it recognises: missing them means re-flagging fixed code, the \"temporal misalignment\" failure. " +
  "95% CIs come from resampling whole PRs.");
emit();
emit("| System | Accuracy | Balanced acc. | Resolved recall | Resolved precision | False-resolved rate | Abstained |");
emit("|---|---|---|---|---|---|---|");

const allPreds = new Map<string, Map<string, Pred>>();
for (const s of systems) {
  const preds = new Map(cases.map((c) => [c.id, s.predict(c)]));
  allPreds.set(s.name, preds);
  const m = score(cases, preds);
  emit(`| ${s.name} | ${pct(m.acc)} (${ci(bootstrap(cases, preds, "acc"))}) | ${pct(m.balAcc)} | ${pct(m.resolvedRecall)} | ` +
    `${pct(m.resolvedPrecision)} | ${pct(m.falseResolved)} (${ci(bootstrap(cases, preds, "falseResolved"))}) | ${pct(m.abstain)} |`);
}
emit();
for (const s of systems) emit(`- **${s.name}**: ${s.note}`);

// Per-round breakdown: does state tracking degrade as the PR goes on?
emit();
emit("## By review round (balanced accuracy)");
emit();
const buckets: [string, (c: Case) => boolean][] = [["2", (c) => c.round === 2], ["3", (c) => c.round === 3], ["4", (c) => c.round === 4], ["5+", (c) => c.round >= 5]];
emit(`| System | ${buckets.map(([b]) => `Round ${b} (n=${cases.filter(buckets.find((x) => x[0] === b)![1]).length})`).join(" | ")} |`);
emit(`|---|${buckets.map(() => "---").join("|")}|`);
for (const s of systems) {
  emit(`| ${s.name} | ${buckets.map(([, f]) => pct(score(cases.filter(f), allPreds.get(s.name)!).balAcc)).join(" | ")} |`);
}

emit();
emit("## By severity (false-resolved rate: lower is safer)");
emit();
const sev: [string, (c: Case) => boolean][] = [["Blocker/Critical/Major", (c) => ["Blocker", "Critical", "Major"].includes(c.severity)], ["Normal/Minor/Trivial", (c) => !["Blocker", "Critical", "Major"].includes(c.severity)]];
emit(`| System | ${sev.map(([n, f]) => `${n} (n=${cases.filter(f).length})`).join(" | ")} |`);
emit("|---|---|---|");
for (const s of systems) emit(`| ${s.name} | ${sev.map(([, f]) => pct(score(cases.filter(f), allPreds.get(s.name)!).falseResolved)).join(" | ")} |`);

if (cache.size > 0) {
  const answered = cases.flatMap((c) => [cache.get(c.id), cache.get(`${c.id}:full`)]).filter((a): a is JevAnswer => !!a);
  const tokens = answered.reduce((s, a) => s + a.tokens, 0);
  const ms = answered.map((a) => a.ms).sort((a, b) => a - b);
  emit();
  emit("## Retrace cost");
  emit();
  emit(`- Jev coverage: ${jevCoverage}/${cases.length} cases scored (the rest are missing answers and count as abstained).`);
  emit(`- ${pct(cases.filter((c) => !c.patch).length / cases.length)} of cases needed **no model call** (file untouched).`);
  emit(`- ${answered.length} Jev calls (both variants), ${tokens.toLocaleString("en-US")} input tokens, ≈ $${(tokens * JEV_PRICE_PER_TOKEN).toFixed(4)} total.`);
  emit(`- Latency per call: median ${ms[Math.floor(ms.length / 2)] ?? "–"} ms, p95 ${ms[Math.floor(ms.length * 0.95)] ?? "–"} ms.`);

  // Calibration: are Jev's probabilities honest? This is what makes threshold tuning (and later, risk control) possible.
  emit();
  emit("## Calibration of P(fixed)");
  emit();
  emit("| P(fixed) bin | Cases | Actually resolved |");
  emit("|---|---|---|");
  const preds = allPreds.get("Retrace (Jev)")!;
  const scored = cases.filter((c) => preds.get(c.id)!.p !== undefined && c.patch);
  let brier = 0;
  for (let lo = 0; lo < 1; lo += 0.2) {
    const bin = scored.filter((c) => { const p = preds.get(c.id)!.p!; return p >= lo && (p < lo + 0.2 || lo >= 0.8); });
    emit(`| ${lo.toFixed(1)}–${(lo + 0.2).toFixed(1)} | ${bin.length} | ${pct(bin.filter((c) => c.label === "Resolved").length / bin.length)} |`);
  }
  for (const c of scored) brier += (preds.get(c.id)!.p! - (c.label === "Resolved" ? 1 : 0)) ** 2;
  emit();
  emit(`Brier score: ${(brier / scored.length).toFixed(3)} (lower is better; ${scored.length} cases where Jev was called).`);

  // Threshold tuned on a dev split of PRs, reported on the held-out rest.
  emit();
  emit("## Tuned threshold (dev/test split by PR)");
  emit();
  const isDev = (c: Case) => hash(c.pr) % 10 < 3;
  const dev = cases.filter(isDev), test = cases.filter((c) => !isDev(c));
  const at = (t: number) => new Map(cases.map((c) => { const p = preds.get(c.id)!; return [c.id, { resolved: (p.p ?? 0) >= t }]; }));
  const target = 0.05;
  const t = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99].find((th) => score(dev, at(th)).falseResolved <= target) ?? 0.99;
  const m = score(test, at(t));
  emit(`Smallest threshold with false-resolved ≤ ${pct(target)} on dev (${dev.length} cases): **${t}**. ` +
    `On held-out test (${test.length} cases): false-resolved ${pct(m.falseResolved)}, resolved recall ${pct(m.resolvedRecall)}, balanced accuracy ${pct(m.balAcc)}.`);
}

emit();
emit("## Caveats");
emit();
emit("- MCR-bench labels come from an LLM annotation pipeline (3 runs + consistency check), not human review.");
emit("- Defect text is the annotator's summary, not the original reviewer comment, and may be cleaner than real review threads.");
emit("- This scores state tracking only. It doesn't measure finding new defects (MCR-bench's main precision/recall/F1 task).");

const report = out.join("\n");
writeFileSync(join(RESULTS, "report.md"), `${report}\n`);
console.log(report);

// ---------- utils ----------

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
