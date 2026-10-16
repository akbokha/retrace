import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Status } from "./ledger.js";

export interface Assessment {
  status: Status;
  /** Jev's probability that the push touched the commented code. */
  pTouched: number;
  /** Jev's confidence in the status it picked. */
  confidence: number;
  tokens: number;
}

export interface AssessInput {
  path: string;
  reviewComment: string;
  /** The diff hunk the comment was left on. */
  codeWhenCommented: string;
  /** The relevant part of this push's diff for `path`. */
  newDiff: string;
}

const QUESTIONS = {
  touched: {
    type: "noul",
    instructions:
      "Does `new_change.diff` modify the code that `review_comment` is about? " +
      "That code is shown at the end of `review_comment.code_when_commented`.",
  },
  outcome: {
    type: "choice",
    instructions:
      "After `new_change.diff` is applied, what happened to the problem described in " +
      "`review_comment.reviewer_comment`?",
    criteria: {
      fixed: "The change fully resolves the problem the reviewer described.",
      partially_fixed: "The change addresses part of the problem, but some of what the reviewer asked for is still missing.",
      not_addressed: "The change does not address the problem. It is still present.",
      made_worse: "The change makes the problem worse or introduces a closely related new problem.",
    },
  },
} as const;

export class Judge {
  private client: TypeSafeClient;

  constructor(
    opts: { apiKey: string; baseURL?: string; model: string },
    private minConfidence: number,
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
    const { answers, usage } = await this.client.systemOne({
      state: {
        review_comment: {
          file: input.path,
          reviewer_comment: input.reviewComment,
          code_when_commented: input.codeWhenCommented,
        },
        new_change: { file: input.path, diff: input.newDiff },
      },
      questions: QUESTIONS,
    });

    const tokens = usage.input_tokens ?? 0;
    const pTouched = answers.touched.noul;
    const { choice, confidence } = answers.outcome;

    let status: Status;
    if (pTouched < this.touchThreshold) status = "untouched";
    else if (confidence < this.minConfidence) status = "unsure";
    else status = choice;

    return { status, pTouched, confidence, tokens };
  }
}
