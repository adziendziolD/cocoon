/**
 * Git credentials for HTTPS GitHub remotes, passed as GIT_CONFIG_* env vars for a single command
 * (never written to the sandbox's git config).
 */
/**
 * Lets git use $GITHUB_TOKEN for github.com (git ignores the variable by itself). Only processes that have the token
 * in their environment – agents that got it – can authenticate; everything else gets no credentials.
 */
export const GIT_CREDENTIAL_HELPER_SCRIPT = `git config --global credential.https://github.com.helper '!f() { test -n "$GITHUB_TOKEN" && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f'`;

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
  // github.com must be the host: https://github.com/o/r, ssh://git@github.com/o/r, git@github.com:o/r – not a path or a subdomain.
  const match = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}
