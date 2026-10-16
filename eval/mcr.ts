// Turns MCR-bench (https://github.com/DeepSoftwareAnalytics/MCR-bench) into Retrace's task:
// "a defect was raised in an earlier round; after this round's push, is it Resolved or still Open?"
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LANGS = ["py", "js", "ts", "java", "csharp"] as const;
export type Lang = (typeof LANGS)[number];

interface Defect {
  defect_id: string;
  title: string;
  description: string;
  taxonomy: string;
  severity: string;
  state: "New" | "Open" | "Resolved" | "Reopened";
  previous_state: "NotPresent" | "New" | "Open" | "Resolved" | "Reopened";
  location: { file: string; lines: string };
}

interface McrEvent {
  round_id: string;
  event_type: string;
  author_role?: string;
  body?: string;
  file_path?: string;
  line_start?: string;
  line_end?: string;
  diff_hunk?: string;
}

interface McrRow {
  task_id: string;
  pr_title?: string;
  pr_description?: string;
  events_up_to_round: McrEvent[];
  code_diff: { diff: string; commits: { sha: string; message: string }[] };
  ground_truth: { defects: Defect[] };
}

export interface Case {
  id: string;
  pr: string;
  lang: Lang;
  round: number;
  severity: string;
  previousState: string;
  label: "Resolved" | "Open";
  file: string;
  reviewComment: string;
  codeWhenCommented: string;
  /** This round's diff for `file`, or undefined when the push didn't touch it. */
  patch: string | undefined;
  /** This round's whole diff, for asking Jev even when the defect's file wasn't touched. */
  fullDiff: string;
  /** Messages of the commits pushed in this round. */
  commitMessages: string[];
  prTitle: string;
  prDescription: string;
  /** This file's diffs from earlier pushes since the defect was raised (not including this push). */
  earlierDiffs: string[];
  /** Review/issue comments posted since the defect was raised, before this push (role: text). */
  discussion: string[];
  /** Whether this round's diff changes lines near where the defect was in the previous round. */
  linesTouched: boolean;
}

/** Split a multi-file `diff --git` blob into path -> patch. */
export function splitDiff(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const m = part.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!m) continue;
    const body = part.slice(part.indexOf("\n") + 1).replace(/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename ).*\n/gm, "");
    files.set(m[2], body);
    if (m[1] !== m[2]) files.set(m[1], body);
  }
  return files;
}

function parseLines(lines: string): [number, number] | undefined {
  const m = lines.match(/(\d+)(?:\s*-\s*(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
}

/** Does any hunk's old side overlap [start-pad, end+pad]? */
function hunksOverlap(patch: string, range: [number, number] | undefined, pad = 3): boolean {
  if (!range) return false;
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
    const a = Number(m[1]);
    const b = a + Math.max(Number(m[2] ?? 1), 1) - 1;
    if (a <= range[1] + pad && b >= range[0] - pad) return true;
  }
  return false;
}

/** The code a reviewer saw: the latest earlier review comment near the defect, else an earlier hunk of that file. */
function codeContext(file: string, range: [number, number] | undefined, events: McrEvent[], earlier: McrRow[]): string {
  const near = events.filter((e) => {
    if (e.event_type !== "review_comment" || e.file_path !== file || !e.diff_hunk) return false;
    if (!range) return true;
    const s = Number(e.line_start ?? e.line_end), t = Number(e.line_end ?? e.line_start);
    return s <= range[1] + 5 && t >= range[0] - 5;
  });
  if (near.length) return near[near.length - 1].diff_hunk!;

  for (const row of [...earlier].reverse()) {
    const patch = splitDiff(row.code_diff.diff).get(file);
    if (!patch) continue;
    const hunks = patch.split(/^(?=@@ )/m).filter((h) => h.startsWith("@@"));
    const hit = hunks.find((h) => {
      const m = h.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/);
      if (!m || !range) return false;
      const c = Number(m[1]), d = c + Number(m[2] ?? 1) - 1;
      return c <= range[1] + 3 && d >= range[0] - 3;
    });
    return (hit ?? hunks[0] ?? "").slice(0, 3000);
  }
  return "(code not available)";
}

export function loadCases(dataDir: string, langs: readonly Lang[]): Case[] {
  const cases: Case[] = [];
  for (const lang of langs) {
    const rows = readFileSync(join(dataDir, `${lang}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as McrRow);
    const byPr = new Map<string, McrRow[]>();
    for (const r of rows) {
      const pr = r.task_id.replace(/_round\d+$/, "");
      byPr.set(pr, [...(byPr.get(pr) ?? []), r]);
    }

    for (const [pr, prRows] of byPr) {
      prRows.sort((a, b) => round(a) - round(b));
      const raised = new Map<string, number>();
      for (const r of prRows) for (const d of r.ground_truth.defects) if (!raised.has(d.defect_id)) raised.set(d.defect_id, round(r));
      for (let i = 1; i < prRows.length; i++) {
        const row = prRows[i];
        const prev = new Map(prRows[i - 1].ground_truth.defects.map((d) => [d.defect_id, d]));
        const files = splitDiff(row.code_diff.diff);

        for (const d of row.ground_truth.defects) {
          // A defect that was open going into this round, and is either still open or resolved after it.
          if (!["New", "Open", "Reopened"].includes(d.previous_state)) continue;
          if (d.state !== "Resolved" && d.state !== "Open") continue;
          const before = prev.get(d.defect_id) ?? d;
          const file = before.location.file;
          const range = parseLines(before.location.lines);
          const patch = files.get(file);

          cases.push({
            id: `${row.task_id}:${d.defect_id}`,
            pr,
            lang,
            round: round(row),
            severity: d.severity,
            previousState: d.previous_state,
            label: d.state,
            file,
            reviewComment: `${before.title}\n\n${before.description}`,
            codeWhenCommented: codeContext(file, range, row.events_up_to_round, prRows.slice(0, i)),
            patch,
            fullDiff: row.code_diff.diff,
            commitMessages: (row.code_diff.commits ?? []).map((c) => c.message),
            prTitle: row.pr_title ?? "",
            prDescription: row.pr_description ?? "",
            earlierDiffs: prRows
              .slice(0, i)
              .filter((r) => round(r) > (raised.get(d.defect_id) ?? round(row)))
              .map((r) => splitDiff(r.code_diff.diff).get(file))
              .filter((x): x is string => !!x),
            discussion: row.events_up_to_round
              .filter((e) => (e.event_type === "review_comment" || e.event_type === "issue_comment") && e.body?.trim())
              .filter((e) => Number(e.round_id) >= (raised.get(d.defect_id) ?? 0))
              .filter((e) => e.event_type === "issue_comment" || e.file_path === file)
              .map((e) => `${e.author_role ?? "someone"}: ${e.body!.replace(/\s+/g, " ").slice(0, 300)}`),
            linesTouched: patch ? hunksOverlap(patch, range) : false,
          });
        }
      }
    }
  }
  return cases;
}

function round(r: McrRow): number {
  return Number(r.task_id.match(/_round(\d+)$/)![1]);
}
