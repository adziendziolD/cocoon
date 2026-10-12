/**
 * Git credentials for HTTPS GitHub remotes, passed as GIT_CONFIG_* env vars for a single command
 * (never written to the sandbox's git config).
 */
export function githubAuthEnv(url: string, token: string | undefined): Record<string, string> {
  if (!token || !/^https:\/\/github\.com\//.test(url)) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function parseGithubRepo(url: string): { owner: string; repo: string } | undefined {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}
