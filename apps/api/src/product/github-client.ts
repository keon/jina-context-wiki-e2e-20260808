import { ApiError } from "./errors.js";

const GITHUB_USER_AGENT = "jina-code-review";

export interface GithubPullRequest {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  user?: {
    login?: string;
  };
  head: {
    sha: string;
    ref: string;
  };
  base: {
    sha?: string;
    ref?: string;
  };
}

export async function githubJson<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new ApiError(
      response.status === 404 ? 404 : 502,
      `GitHub GET ${path} failed: ${response.status}`,
      await response.text(),
    );
  }
  return (await response.json()) as T;
}
