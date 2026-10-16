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
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
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
  const res = await octokit.graphql<ThreadsResponse>(THREADS_QUERY, { owner, repo, number });
  return res.repository.pullRequest.reviewThreads.nodes.flatMap((t) => {
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

/** Map of file path -> patch for the commits pushed between `before` and `after`. */
export async function pushDiff(
  octokit: Octokit, owner: string, repo: string, before: string, after: string,
): Promise<Map<string, string>> {
  const res = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${before}...${after}` });
  const files = new Map<string, string>();
  for (const f of res.data.files ?? []) {
    // Binary or huge files have no patch. Mark them changed so they still get looked at.
    files.set(f.filename, f.patch ?? "(no textual diff available)");
    if (f.previous_filename) files.set(f.previous_filename, f.patch ?? "");
  }
  return files;
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
