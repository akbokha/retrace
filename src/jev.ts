import { TypeSafeClient } from "@typesafe-ai/sdk";
import { anchorLines, otherFiles, relevantHunks } from "./diff.js";
import type { Status } from "./ledger.js";

/** Bump when the questions or state change, so cached eval answers aren't mixed across versions. */
export const QUESTIONS_VERSION = "q2";

export interface Assessment {
  status: Status;
  /** Jev's probability that the push touched the commented code. */
  pTouched: number;
  /** Jev's probability that the reviewer's concern is addressed. This decides ✅. */
  pAddressed: number;
  /** Jev's confidence in the outcome label used for threads that aren't fixed. */
  confidence: number;
  outcomeProbs: Record<keyof typeof QUESTIONS.outcome.criteria, number>;
  tokens: number;
}

export interface AssessInput {
  path: string;
  reviewComment: string;
  /** The diff hunk the comment was left on. */
  codeWhenCommented: string;
  /** Every file changed by this push: path -> patch. Must include `path`. */
  pushFiles: Map<string, string>;
  /** Messages of the commits in this push. */
  commitMessages: string[];
}

// Chosen on MCR-bench's dev split and confirmed on held-out PRs (see eval/). A yes/no "addressed?" question,
// plus commit messages and the other files in the push, beat a single 4-way choice on the commented file alone.
export const QUESTIONS = {
  touched: {
    type: "noul",
    instructions: "Does `new_change` modify the code that `review_comment` is about?",
  },
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
  // Only used to label threads that aren't fixed.
  outcome: {
    type: "choice",
    instructions: "If the concern in `review_comment.reviewer_comment` is not fully addressed by `new_change`, what is its state?",
    criteria: {
      partially_fixed: "Part of what the reviewer asked for is done, but some of it is still missing.",
      not_addressed: "The change does not address the problem. It is still present.",
      made_worse: "The change makes the problem worse or introduces a closely related new problem.",
    },
  },
} as const;

/** The state Retrace sends for one thread. Shared with eval/llm.ts so LLM baselines see exactly the same input. */
export function decisionState(input: AssessInput) {
  const anchors = anchorLines(input.codeWhenCommented);
  const patch = input.pushFiles.get(input.path) ?? "";
  return {
    review_comment: {
      file: input.path,
      reviewer_comment: input.reviewComment,
      code_when_commented: input.codeWhenCommented,
    },
    new_change: {
      file: input.path,
      diff: relevantHunks(patch, anchors, 4500),
      commit_messages: input.commitMessages.map((m) => m.slice(0, 200)).slice(0, 8),
      other_files_changed: otherFiles(input.pushFiles, input.path, anchors),
    },
  };
}

export class Judge {
  private client: TypeSafeClient;

  constructor(
    opts: { apiKey: string; baseURL?: string; model: string },
    /** P(addressed) at or above this is ✅. 0.76 ≈ 14% false-resolved on held-out MCR-bench, 0.88 ≈ 6%. */
    private fixedThreshold = 0.76,
    private minConfidence = 0.6,
    private touchThreshold = 0.3,
  ) {
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      defaultModel: opts.model,
      // Any server speaking POST /v1/systemone works here (e.g. self-hosted Kev).
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async assess(input: AssessInput): Promise<Assessment> {
    const { answers, usage } = await this.client.systemOne({ state: decisionState(input), questions: QUESTIONS });

    const pTouched = answers.touched.noul;
    const pAddressed = answers.addressed.noul;
    const { choice, confidence, probabilities } = answers.outcome;

    let status: Status;
    if (pAddressed >= this.fixedThreshold) status = "fixed";
    else if (pTouched < this.touchThreshold) status = "untouched";
    else if (confidence < this.minConfidence) status = "unsure";
    else status = choice;

    return { status, pTouched, pAddressed, confidence, outcomeProbs: { ...probabilities }, tokens: usage.input_tokens ?? 0 };
  }
}
