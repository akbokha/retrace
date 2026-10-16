// Cascade: Jev filters, an LLM confirms. ✅ only when Jev's P(addressed) ≥ gate AND the LLM's ≥ threshold.
// Every system's thresholds are tuned on the dev PRs, then applied unchanged to the held-out PRs.
// Uses cached answers only (run `npm run eval -- --jev` and `npm run llm -- --split dev` / `--split test` first).
//
//   npm run cascade
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTIONS_VERSION } from "../src/jev.js";
import { type Case, LANGS, loadCases } from "./mcr.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");
const LLM = "claude-sonnet-5-5";
const JEV_PER_1K = 0.062, LLM_PER_1K = 4.38; // measured in eval/llm.ts

const load = (f: string) => new Map<string, Record<string, number>>(readFileSync(join(RESULTS, f), "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }));
const jev = load(`jev-jev-latest-${QUESTIONS_VERSION}.jsonl`), llm = load(`llm-${LLM}.jsonl`);
const hash = (s: string) => { let h = 2166136261; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0; return h; };

type Row = { pr: string; y: number; j: number; s: number; called: boolean };
const all = loadCases(join(here, "data/MCR-bench/MCR-bench/dataset"), LANGS).filter((c) => !c.patch || (jev.has(c.id) && llm.has(c.id)));
const row = (c: Case): Row => ({ pr: c.pr, y: c.label === "Resolved" ? 1 : 0, j: c.patch ? jev.get(c.id)!.pAddressed : 0, s: c.patch ? llm.get(c.id)!.pAddressed : 0, called: !!c.patch });
const dev = all.filter((c) => hash(c.pr) % 10 < 3).map(row), test = all.filter((c) => hash(c.pr) % 10 >= 3).map(row);

const ev = (rs: Row[], a: number, b: number) => {
  let tp = 0, fp = 0;
  const P = rs.filter((r) => r.y).length, N = rs.length - P;
  for (const r of rs) if (r.called && r.j >= a && r.s >= b) r.y ? tp++ : fp++;
  return { recall: tp / P, frr: fp / N, precision: tp / (tp + fp) };
};
const grid = Array.from({ length: 50 }, (_, i) => 0.5 + i * 0.01);
const tune = (budget: number, aG: number[], bG: number[]) => {
  let best = { a: 1, b: 1, recall: -1 };
  for (const a of aG) for (const b of bG) { const x = ev(dev, a, b); if (x.frr <= budget && x.recall > best.recall) best = { a, b, recall: x.recall }; }
  return best;
};
/** 95% CI of a paired difference, resampling whole PRs. */
function ci(f: (rs: Row[]) => number) {
  const byPr = new Map<string, Row[]>();
  for (const r of test) byPr.set(r.pr, [...(byPr.get(r.pr) ?? []), r]);
  const g = [...byPr.values()];
  let seed = 5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const xs = Array.from({ length: 1000 }, () => f(Array.from({ length: g.length }, () => g[Math.floor(rnd() * g.length)]).flat())).sort((a, b) => a - b);
  return `[${(xs[25] * 100).toFixed(1)}, ${(xs[974] * 100).toFixed(1)}]`;
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const out: string[] = [];
const emit = (s = "") => out.push(s);
emit(`# Cascade: Jev filters, ${LLM} confirms`);
emit();
emit(`Held-out PRs: ${test.length} cases. All thresholds tuned on ${dev.length} dev cases, then applied unchanged.`);
const calledT = test.filter((r) => r.called).length;
for (const budget of [0.05, 0.03]) {
  const jo = tune(budget, grid, [0]), so = tune(budget, [0], grid), both = tune(budget, grid, grid);
  const J = ev(test, jo.a, 0), S = ev(test, 0, so.b), B = ev(test, both.a, both.b);
  const sent = test.filter((r) => r.called && r.j >= both.a).length / calledT;
  emit();
  emit(`## Target ≤${budget * 100}% false-resolved (on dev)`);
  emit();
  emit("| System | Thresholds | Recall | False-resolved | Precision of ✅ | Cost / 1k checks |");
  emit("|---|---|---|---|---|---|");
  emit(`| Jev only | ≥${jo.a.toFixed(2)} | ${pct(J.recall)} | ${pct(J.frr)} | ${pct(J.precision)} | $${JEV_PER_1K.toFixed(2)} |`);
  emit(`| ${LLM} only | ≥${so.b.toFixed(2)} | ${pct(S.recall)} | ${pct(S.frr)} | ${pct(S.precision)} | $${LLM_PER_1K.toFixed(2)} |`);
  emit(`| **Cascade** | Jev ≥${both.a.toFixed(2)}, then ${LLM} ≥${both.b.toFixed(2)} | ${pct(B.recall)} | ${pct(B.frr)} | ${pct(B.precision)} | $${(JEV_PER_1K + sent * LLM_PER_1K).toFixed(2)} (LLM on ${pct(sent)} of checks) |`);
  emit();
  emit(`95% CIs (PR bootstrap): ${LLM} − Jev recall ${ci((rs) => ev(rs, 0, so.b).recall - ev(rs, jo.a, 0).recall)} pts; ` +
    `cascade − ${LLM} recall ${ci((rs) => ev(rs, both.a, both.b).recall - ev(rs, 0, so.b).recall)} pts, ` +
    `false-resolved ${ci((rs) => ev(rs, both.a, both.b).frr - ev(rs, 0, so.b).frr)} pts.`);
}
const report = out.join("\n");
writeFileSync(join(RESULTS, "cascade.md"), `${report}\n`);
console.log(report);
