// Optional LLM verifier: asks a Claude model the same question Jev answers, on the same state.
// Used by the Action's cascade (Jev filters, Claude confirms ✅) and by eval/llm.ts.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { QUESTIONS } from "./jev.js";

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

export interface Verdict {
  pTouched: number;
  pAddressed: number;
  inputTokens: number;
  outputTokens: number;
}

export class Verifier {
  private client: Anthropic;

  constructor(private model: string, apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async verify(state: object): Promise<Verdict> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt(state) }],
      output_config: { effort: "low", format: zodOutputFormat(Answer) },
      // Lowest-latency setting for a quick yes/no check: no extended thinking on Sonnet 5.5, low effort elsewhere.
      ...(this.model === "claude-sonnet-5-5" ? { thinking: { type: "between_tools" } as Anthropic.MessageCreateParams["thinking"] } : {}),
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no answer (stop_reason: ${res.stop_reason})`);
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    return {
      pTouched: clamp(res.parsed_output.touched_probability),
      pAddressed: clamp(res.parsed_output.addressed_probability),
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    };
  }
}
