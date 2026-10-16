// LLM baseline: the same state and the same question Retrace sends to Jev, asked of a Claude model instead.
// Scored on the held-out test split (the PRs not used to choose Retrace's questions) against the shipped Jev answers.
//
//   npm run llm -- --limit 20                          # pilot: real cost per call before a full run
//   npm run llm                                        # full held-out split with Claude Sonnet 5.5, thinking off
//   npm run llm -- --model claude-opus-5-5 --limit 300 # Opus on a sample
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { decisionState, QUESTIONS, QUESTIONS_VERSION } from "../src/jev.js";
import { type Case, LANGS, loadCases, splitDiff } from "./mcr.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");
const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "claude-sonnet-5-5" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "8" },
  },
});
const model = args.model!;

/** $ per million tokens, input / output (Claude API list prices, Oct 2026). Jev: $0.042 input, output free. */
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-haiku-5-5": [0.1, 0.5],
};
const JEV_PRICE = 0.042;

// ---------- the question, worded as for Jev ----------

const Answer = z.object({
  touched_probability: z.number(),
  addressed_probability: z.number(),
});

const SYSTEM =
  "You track code review comments across the pushes of a pull request. You get a JSON state with a reviewer's " +
  "comment (and the code it was left on) and a new push. Answer each question with a probability from 0 to 1 " +
  "that the answer is yes. Make the probabilities calibrated: of all the times you say 0.8, about 80% should be yes.";

const prompt = (state: object) =>
  `<state>\n${JSON.stringify(state, null, 1)}\n</state>\n\n` +
  `touched_probability: ${QUESTIONS.touched.instructions}\n\n` +
  `addressed_probability: ${QUESTIONS.addressed.instructions}\n` +
  `Yes means: ${QUESTIONS.addressed.criteria.true}\nNo means: ${QUESTIONS.addressed.criteria.false}`;

// Lowest-latency setup for a quick yes/no check: no extended thinking on Sonnet 5.5, low effort elsewhere.
function thinkingParams(): Pick<Anthropic.MessageCreateParams, "thinking" | "output_config"> {
  if (model === "claude-sonnet-5-5") return { thinking: { type: "between_tools" } as Anthropic.MessageCreateParams["thinking"], output_config: { effort: "low" } };
  return { output_config: { effort: "low" } };
}

// ---------- run ----------

interface LlmAnswer { id: string; pTouched: number; pAddressed: number; inTok: number; outTok: number; ms: number; stop: string }

const isDev = (pr: string) => hash(pr) % 10 < 3; // same split as eval/run.ts and eval/variants.ts
let test = loadCases(join(here, "data/MCR-bench/MCR-bench/dataset"), LANGS).filter((c) => !isDev(c.pr));
test.sort((a, b) => hash(`llm:${a.id}`) - hash(`llm:${b.id}`)); // deterministic sample for --limit
if (args.limit) test = test.slice(0, Number(args.limit));

const cachePath = join(RESULTS, `llm-${model}.jsonl`);
const cache = new Map<string, LlmAnswer>(
  existsSync(cachePath) ? readFileSync(cachePath, "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }) : [],
);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to .env (see README).");
  process.exit(1);
}
const client = new Anthropic();
const todo = test.filter((c) => c.patch && !cache.has(c.id));
console.error(`${model}: ${todo.length} calls (${cache.size} cached)`);

let i = 0, failed = 0;
await Promise.all(Array.from({ length: Math.min(Number(args.concurrency), todo.length) }, async () => {
  while (i < todo.length) {
    const c = todo[i++];
    const t0 = Date.now();
    try {
      const state = decisionState({ path: c.file, reviewComment: c.reviewComment, codeWhenCommented: c.codeWhenCommented, pushFiles: splitDiff(c.fullDiff), commitMessages: c.commitMessages });
      const res = await client.messages.parse({
        model,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt(state) }],
        output_config: { ...thinkingParams().output_config, format: zodOutputFormat(Answer) },
        ...(thinkingParams().thinking ? { thinking: thinkingParams().thinking } : {}),
      });
      if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no answer (stop_reason: ${res.stop_reason})`);
      const clamp = (x: number) => Math.min(1, Math.max(0, x));
      const a: LlmAnswer = {
        id: c.id,
        pTouched: clamp(res.parsed_output.touched_probability),
        pAddressed: clamp(res.parsed_output.addressed_probability),
        inTok: res.usage.input_tokens,
        outTok: res.usage.output_tokens,
        ms: Date.now() - t0,
        stop: res.stop_reason ?? "",
      };
      cache.set(c.id, a);
      appendFileSync(cachePath, `${JSON.stringify(a)}\n`);
    } catch (err) {
      if (++failed <= 3) console.error(`  ${c.id}: ${(err as Error).message}`);
    }
  }
}));
if (failed) console.error(`${failed} calls failed (rerun to retry them)`);

// ---------- compare with the shipped Jev answers on the same cases ----------

const jev = new Map<string, { pAddressed: number; tokens: number; ms: number }>(
  readFileSync(join(RESULTS, `jev-jev-latest-${QUESTIONS_VERSION}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); return [a.id, a]; }),
);
// Only cases both systems answered. Untouched files are "still open" (p = 0) for both: same file filter.
const scored = test.filter((c) => !c.patch || (cache.has(c.id) && jev.has(c.id)));
const y = scored.map((c) => (c.label === "Resolved" ? 1 : 0));
const pJev = scored.map((c) => (c.patch ? jev.get(c.id)!.pAddressed : 0));
const pLlm = scored.map((c) => (c.patch ? cache.get(c.id)!.pAddressed : 0));
const called = scored.filter((c) => c.patch);

const out: string[] = [];
const emit = (s = "") => out.push(s);
emit(`# Jev vs ${model} on held-out MCR-bench PRs`);
emit();
emit(`${scored.length} cases (${called.length} needing a model call), ${pct(y.filter(Boolean).length / y.length)} resolved. ` +
  "Both systems get the same state and the same question. Untouched files count as still open for both.");
emit();
emit("| System | AUROC | Recall @ ≤5% false-resolved | Recall @ ≤12% false-resolved | Brier | At p ≥ 0.5: recall / false-resolved |");
emit("|---|---|---|---|---|---|");
for (const [name, p] of [["Jev (jev-latest)", pJev], [model, pLlm]] as const) {
  const r = rates(p.map((v) => v >= 0.5));
  emit(`| ${name} | ${auroc(p).toFixed(3)} | ${pct(recallAt(p, 0.05))} | ${pct(recallAt(p, 0.12))} | ${brier(p, called).toFixed(3)} | ${pct(r.recall)} / ${pct(r.frr)} |`);
}
emit();
emit("Recall @ budget picks the best threshold on these same cases for each system: optimistic for both, but equally so.");

const jevAns = called.map((c) => jev.get(c.id)!);
const llmAns = called.map((c) => cache.get(c.id)!);
const [pin, pout] = PRICES[model] ?? [Number.NaN, Number.NaN];
const jevCost = (jevAns.reduce((s, a) => s + a.tokens, 0) * JEV_PRICE) / 1e6;
const llmCost = llmAns.reduce((s, a) => s + a.inTok * pin + a.outTok * pout, 0) / 1e6;
const q = (xs: number[], f: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
emit();
emit("| System | Cost per 1,000 checks | Median latency | p95 latency | Avg input / output tokens |");
emit("|---|---|---|---|---|");
emit(`| Jev | $${((jevCost / called.length) * 1000).toFixed(3)} | ${q(jevAns.map((a) => a.ms), 0.5)} ms | ${q(jevAns.map((a) => a.ms), 0.95)} ms | ${Math.round(jevAns.reduce((s, a) => s + a.tokens, 0) / called.length)} / 0 |`);
emit(`| ${model} | $${((llmCost / called.length) * 1000).toFixed(3)} | ${q(llmAns.map((a) => a.ms), 0.5)} ms | ${q(llmAns.map((a) => a.ms), 0.95)} ms | ` +
  `${Math.round(llmAns.reduce((s, a) => s + a.inTok, 0) / called.length)} / ${Math.round(llmAns.reduce((s, a) => s + a.outTok, 0) / called.length)} |`);
emit();
emit(`This run: ${called.length} ${model} calls ≈ $${llmCost.toFixed(2)}. Latencies were measured at concurrency ${args.concurrency} from this machine; the Jev latencies come from the earlier full run.`);

const report = out.join("\n");
writeFileSync(join(RESULTS, `llm-${model}.md`), `${report}\n`);
console.log(report);

// ---------- metrics ----------

function rates(pred: boolean[]) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  pred.forEach((r, k) => (y[k] ? (r ? tp++ : fn++) : r ? fp++ : tn++));
  return { recall: tp / (tp + fn), frr: fp / (fp + tn) };
}
function recallAt(p: number[], budget: number) {
  let best = 0;
  for (const t of [...new Set(p)].filter((t) => t > 0)) { const r = rates(p.map((v) => v >= t)); if (r.frr <= budget) best = Math.max(best, r.recall); }
  return best;
}
function auroc(p: number[]) {
  const pos = p.filter((_, k) => y[k]), neg = p.filter((_, k) => !y[k]);
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
/** Brier over the cases where a model was called (untouched files are 0 for both and would only dilute it). */
function brier(p: number[], cs: Case[]) {
  const ids = new Set(cs.map((c) => c.id));
  let s = 0, n = 0;
  scored.forEach((c, k) => { if (ids.has(c.id)) { s += (p[k] - y[k]) ** 2; n++; } });
  return s / n;
}
function pct(x: number) { return Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`; }
function hash(s: string) { let h = 2166136261; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0; return h; }
