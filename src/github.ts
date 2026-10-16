import type { getOctokit } from "@actions/github";
import { MARKER } from "./ledger.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  author: string;
  body: string;
  diffHunk: string;
  url: string;
}

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path
          comments(first: 1) { nodes { author { login } body diffHunk url } }
        }
      }
    }
  }
}`;

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          comments: { nodes: { author: { login: string } | null; body: string; diffHunk: string; url: string }[] };
        }[];
      };
    };
  };
}

export async function listThreads(octokit: Octokit, owner: string, repo: string, number: number): Promise<Thread[]> {
  const nodes: ThreadsResponse["repository"]["pullRequest"]["reviewThreads"]["nodes"] = [];
  let cursor: string | null = null;
  do {
    const res: ThreadsResponse = await octokit.graphql<ThreadsResponse>(THREADS_QUERY, { owner, repo, number, cursor });
    const page = res.repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return nodes.flatMap((t) => {
    const c = t.comments.nodes[0];
    if (!c) return [];
    return [{
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      author: c.author?.login ?? "ghost",
      body: c.body,
      diffHunk: c.diffHunk,
      url: c.url,
    }];
  });
}

/**
 * File path -> patch, and the commit messages, for the commits pushed between `before` and `after`.
 * Returns undefined when the push can't be diffed as "new commits on top": a force-push or rebase, or a
 * `before` commit that no longer exists. Judging against a rewritten history would mislead, so we skip.
 */
export async function pushDiff(
  octokit: Octokit, owner: string, repo: string, before: string, after: string,
): Promise<{ files: Map<string, string>; commitMessages: string[] } | undefined> {
  let res;
  try {
    res = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${before}...${after}` });
  } catch {
    return undefined;
  }
  if (res.data.status !== "ahead") return undefined;
  const files = new Map<string, string>();
  for (const f of res.data.files ?? []) {
    // Binary or huge files have no patch. Mark them changed so they still get looked at.
    files.set(f.filename, f.patch ?? "(no textual diff available)");
    if (f.previous_filename) files.set(f.previous_filename, f.patch ?? "");
  }
  return { files, commitMessages: res.data.commits.map((c) => c.commit.message) };
}

export async function findSticky(octokit: Octokit, owner: string, repo: string, number: number) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number });
  return comments.find((c) => c.body?.includes(MARKER));
}

export async function upsertSticky(
  octokit: Octokit, owner: string, repo: string, number: number, existingId: number | undefined, body: string,
) {
  if (existingId) await octokit.rest.issues.updateComment({ owner, repo, comment_id: existingId, body });
  else await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
}
