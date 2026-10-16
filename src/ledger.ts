// The ledger: per-thread state history across pushes, stored as hidden JSON in Retrace's sticky PR comment.

export type Status = "fixed" | "partially_fixed" | "not_addressed" | "made_worse" | "untouched" | "unsure";

export interface Entry {
  url: string;
  path: string;
  author: string;
  summary: string;
  /** One status per round, oldest first. */
  history: { round: number; sha: string; status: Status; confidence?: number }[];
}

export interface Ledger {
  round: number;
  threads: Record<string, Entry>;
}

export const MARKER = "<!-- retrace:sticky -->";
const DATA_RE = /<!-- retrace:ledger ([A-Za-z0-9+/=]+) -->/;

const BADGE: Record<Status, string> = {
  fixed: "✅ likely fixed",
  partially_fixed: "🟡 partially fixed",
  not_addressed: "🔴 still open",
  made_worse: "⚠️ made worse",
  untouched: "⏸️ not touched",
  unsure: "❔ unsure",
};
const DOT: Record<Status, string> = {
  fixed: "✅",
  partially_fixed: "🟡",
  not_addressed: "🔴",
  made_worse: "⚠️",
  untouched: "⏸️",
  unsure: "❔",
};

export function parseLedger(body: string | undefined): Ledger {
  const m = body?.match(DATA_RE);
  if (!m) return { round: 0, threads: {} };
  try {
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Ledger;
  } catch {
    return { round: 0, threads: {} };
  }
}

export interface RunStats {
  checked: number;
  skippedDeterministically: number;
  jevCalls: number;
  tokens: number;
  ms: number;
}

export function renderComment(ledger: Ledger, sha: string, stats: RunStats): string {
  const rows = Object.values(ledger.threads)
    .filter((e) => e.history.length > 0)
    .map((e) => {
      // "Now" is the latest real judgment; rounds where the code wasn't touched don't change it.
      const last = [...e.history].reverse().find((h) => h.status !== "untouched") ?? e.history[e.history.length - 1];
      const trail = e.history.map((h) => DOT[h.status]).join(" → ");
      const conf = last.confidence !== undefined && last.status !== "untouched" ? ` (${Math.round(last.confidence * 100)}%)` : "";
      return `| [${escape(e.summary)}](${e.url}) | \`${e.path}\` | ${BADGE[last.status]}${conf} | ${trail} |`;
    });

  const table = rows.length
    ? ["| Review comment | File | Now | History by round |", "|---|---|---|---|", ...rows].join("\n")
    : "_No open review threads to track yet._";

  const encoded = Buffer.from(JSON.stringify(ledger)).toString("base64");
  return [
    MARKER,
    `### 🔁 Retrace: review round ${ledger.round} (\`${sha.slice(0, 7)}\`)`,
    "",
    table,
    "",
    `<sub>${stats.checked} open threads · ${stats.skippedDeterministically} skipped (file untouched, no model call) · ` +
      `${stats.jevCalls} Jev calls · ${stats.tokens.toLocaleString("en-US")} tokens · ${stats.ms} ms. ` +
      "Retrace never resolves threads itself. ✅ means \"worth re-checking\", not \"verified\".</sub>",
    `<!-- retrace:ledger ${encoded} -->`,
  ].join("\n");
}

function escape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\[\]]/g, "");
}

export function summarize(body: string, max = 80): string {
  const first = body.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first || "(comment)";
}
