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
