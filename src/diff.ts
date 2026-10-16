// Small helpers for working with unified diffs from the GitHub API.

/** Split a file patch into hunks, each starting with its `@@` header. */
export function splitHunks(patch: string): string[] {
  return patch.split(/^(?=@@ )/m).filter((h) => h.startsWith("@@"));
}

/** The last few code lines of a review comment's diff hunk: the lines the comment is anchored to. */
export function anchorLines(diffHunk: string, count = 3): string[] {
  return diffHunk
    .split("\n")
    .filter((l) => !l.startsWith("@@"))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length > 2)
    .slice(-count);
}

/**
 * Pick the hunks of `patch` that are most likely about the commented code, capped to `maxChars`.
 * Hunks whose old side contains an anchor line come first. Others follow, because code can move.
 * Keeping this small matters: Jev gets less accurate when the state has lots of irrelevant text.
 */
export function relevantHunks(patch: string, anchors: string[], maxChars = 6000): string {
  const hunks = splitHunks(patch);
  const touchesAnchor = (h: string) =>
    h.split("\n").some((l) => (l.startsWith("-") || l.startsWith(" ")) && anchors.includes(l.slice(1).trim()));
  const ordered = [...hunks.filter(touchesAnchor), ...hunks.filter((h) => !touchesAnchor(h))];

  let out = "";
  for (const h of ordered) {
    if (out.length + h.length > maxChars) break;
    out += h.endsWith("\n") ? h : `${h}\n`;
  }
  return out || patch.slice(0, maxChars);
}

/**
 * Diffs of the other files in a push, most likely related first: files added with the same name (moves),
 * then same name, then same folder. Gives Jev a chance to see fixes made somewhere other than the commented file.
 */
export function otherFiles(
  files: Map<string, string>, path: string, anchors: string[], maxChars = 2500, maxFiles = 4,
): { file: string; diff: string }[] {
  const base = path.split("/").pop()!.replace(/\.\w+$/, "");
  const dir = path.split("/").slice(0, -1).join("/");
  const score = (f: string, patch: string) =>
    (patch.startsWith("@@ -0,0 ") && f.includes(base) ? 4 : 0) + (f.includes(base) ? 2 : 0) + (f.startsWith(dir) ? 1 : 0);
  const ranked = [...files].filter(([f]) => f !== path).sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]));

  const out: { file: string; diff: string }[] = [];
  let used = 0;
  for (const [file, patch] of ranked) {
    const diff = relevantHunks(patch, anchors, Math.min(1500, maxChars - used));
    if (used + diff.length > maxChars || out.length >= maxFiles) break;
    out.push({ file, diff });
    used += diff.length;
  }
  return out;
}
