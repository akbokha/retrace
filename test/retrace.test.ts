import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorLines, otherFiles, relevantHunks, splitHunks } from "../src/diff.js";
import { listThreads, pushDiff } from "../src/github.js";
import { type Ledger, parseLedger, renderComment, summarize } from "../src/ledger.js";

// ---------- diff helpers ----------

const PATCH = "@@ -1,2 +1,2 @@\n-import x\n+import y\n@@ -20,3 +20,3 @@\n-const total = price * qty;\n+const total = price * qty * (1 - discount);\n return total;\n";

test("splitHunks splits on @@ headers", () => {
  assert.equal(splitHunks(PATCH).length, 2);
});

test("relevantHunks puts the hunk with the commented code first", () => {
  const anchors = anchorLines("@@ -1,3 +1,4 @@\n const a = 1;\n+const total = price * qty;\n+return total;");
  assert.ok(relevantHunks(PATCH, anchors).startsWith("@@ -20,3 +20,3 @@"));
});

test("relevantHunks respects the size cap", () => {
  assert.ok(relevantHunks(PATCH, [], 30).length <= 30 + 20);
});

test("otherFiles ranks a moved (newly added, same-name) file first and skips the commented file", () => {
  const files = new Map([
    ["src/a/Foo.java", "@@ -1,3 +0,0 @@\n-class Foo {}"],
    ["src/unrelated.ts", "@@ -1 +1 @@\n-a\n+b"],
    ["src/b/Foo.java", "@@ -0,0 +1,3 @@\n+class Foo {}"],
  ]);
  const out = otherFiles(files, "src/a/Foo.java", []);
  assert.equal(out[0].file, "src/b/Foo.java");
  assert.ok(!out.some((f) => f.file === "src/a/Foo.java"));
});

// ---------- ledger ----------

test("ledger survives a render/parse round trip, and 'Now' skips untouched rounds", () => {
  const l: Ledger = {
    round: 3,
    threads: { T1: { url: "https://x", path: "a.ts", author: "bot", summary: "Missing | discount", history: [
      { round: 1, sha: "a", status: "not_addressed", confidence: 0.8 },
      { round: 2, sha: "b", status: "partially_fixed", confidence: 0.7 },
      { round: 3, sha: "c", status: "untouched" },
    ] } },
  };
  const body = renderComment(l, "abcdef123", { checked: 1, skippedDeterministically: 1, jevCalls: 0, tokens: 0, ms: 1 });
  assert.deepEqual(parseLedger(body), l);
  assert.match(body, /🟡 partially fixed \(70%\)/);
  assert.match(body, /Missing \\\| discount/);
});

test("parseLedger tolerates a missing or corrupt ledger", () => {
  assert.deepEqual(parseLedger(undefined), { round: 0, threads: {} });
  assert.deepEqual(parseLedger("<!-- retrace:ledger !!!notbase64 -->"), { round: 0, threads: {} });
});

test("summarize drops code blocks and truncates", () => {
  assert.equal(summarize("Fix this ```const x = 1``` please"), "Fix this please");
  assert.equal(summarize("x".repeat(200)).length, 80);
});

// ---------- GitHub helpers (fake octokit) ----------

type Fake = Parameters<typeof pushDiff>[0];

function fakeCompare(status: string, files: { filename: string; patch?: string }[] = [], fail = false): Fake {
  return {
    rest: {
      repos: {
        compareCommitsWithBasehead: async () => {
          if (fail) throw new Error("Not Found");
          return { data: { status, files, commits: [{ commit: { message: "address review" } }] } };
        },
      },
    },
  } as unknown as Fake;
}

test("pushDiff returns files and commit messages for a normal push", async () => {
  const r = await pushDiff(fakeCompare("ahead", [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }]), "o", "r", "b", "a");
  assert.equal(r?.files.get("a.ts"), "@@ -1 +1 @@\n-a\n+b");
  assert.deepEqual(r?.commitMessages, ["address review"]);
});

test("pushDiff returns undefined for a force-push (diverged history)", async () => {
  assert.equal(await pushDiff(fakeCompare("diverged"), "o", "r", "b", "a"), undefined);
});

test("pushDiff returns undefined when the old head no longer exists", async () => {
  assert.equal(await pushDiff(fakeCompare("ahead", [], true), "o", "r", "b", "a"), undefined);
});

test("listThreads follows pagination", async () => {
  const thread = (id: string) => ({ id, isResolved: false, isOutdated: false, path: "a.ts", comments: { nodes: [{ author: { login: "r" }, body: "fix", diffHunk: "@@", url: `u/${id}` }] } });
  const pages = [
    { nodes: [thread("1"), thread("2")], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [thread("3")], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const cursors: (string | null)[] = [];
  const fake = { graphql: async (_q: string, v: { cursor: string | null }) => {
    cursors.push(v.cursor);
    return { repository: { pullRequest: { reviewThreads: pages[cursors.length - 1] } } };
  } } as unknown as Parameters<typeof listThreads>[0];
  const threads = await listThreads(fake, "o", "r", 1);
  assert.deepEqual(threads.map((t) => t.id), ["1", "2", "3"]);
  assert.deepEqual(cursors, [null, "c1"]);
});
