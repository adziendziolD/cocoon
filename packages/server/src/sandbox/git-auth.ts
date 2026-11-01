/**
 * Git credentials for HTTPS GitHub remotes, passed as GIT_CONFIG_* env vars for a single command
 * (never written to the sandbox's git config).
 *
 * Such a command runs as the agent user, in a repository and with a home directory the agent controls, while the token
 * is in its environment. githubAuthEnv() therefore also switches on a hardened mode (see GIT_HARDENED_SH) that keeps git
 * from running agent-controlled code (hooks, credential helpers, ssh commands) or talking through an agent-chosen proxy.
 * It cannot hide the token from the agent altogether: see "Restrisiko" in docs/ARCHITECTURE.md.
 */
/**
 * Lets git use $GITHUB_TOKEN for github.com (git ignores the variable by itself). Only processes that have the token
 * in their environment – agents that got it – can authenticate; everything else gets no credentials.
 */
export const GIT_CREDENTIAL_HELPER_SCRIPT = `git config --global credential.https://github.com.helper '!f() { test -n "$GITHUB_TOKEN" && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f'`;

/**
 * Shell function `cgit`: `git`, or – if COCOON_GIT_HARDEN=1 (set by githubAuthEnv), git with the settings an agent could
 * otherwise use to capture the token overridden on the command line (which beats the repository, global and system config):
 * no hooks, no fsmonitor, no ssh command, no credential helper or askpass, TLS verification on, no agent-chosen host
 * resolution, and the proxy pinned to the sandbox's own HTTPS_PROXY (none in open mode). Use it for every git call that
 * runs with the token in its environment.
 */
export const GIT_HARDENED_SH = `cgit() {
  if [ "\${COCOON_GIT_HARDEN:-}" = 1 ]; then
    _cgit_proxy="\${HTTPS_PROXY:-\${https_proxy:-}}"
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.sshCommand=false -c core.askPass= -c credential.helper= \\
      -c http.sslVerify=true -c http.https://github.com/.sslVerify=true -c http.curloptResolve= \\
      -c "http.proxy=$_cgit_proxy" -c "http.https://github.com/.proxy=$_cgit_proxy" "$@"
  else
    git "$@"
  fi
}`;

/**
 * Pushes HEAD to $BRANCH (env). With the token (hardened mode) to the explicit URL $REMOTE_URL, not through the
 * repository's remote configuration, which the agent can edit (pushurl, proxy), and without running pre-push hooks.
 */
export const GIT_PUSH_SCRIPT = `${GIT_HARDENED_SH}
if [ "\${COCOON_GIT_HARDEN:-}" = 1 ]; then
  cgit push --quiet --no-verify -- "$REMOTE_URL" "HEAD:refs/heads/$BRANCH"
else
  git push --quiet origin "HEAD:refs/heads/$BRANCH"
fi`;

export function githubAuthEnv(url: string, token: string | undefined): Record<string, string> {
  if (!token || !/^https:\/\/github\.com\//.test(url)) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
    // Hardened mode (see GIT_HARDENED_SH): no ~/.gitconfig or /etc/gitconfig, no askpass program.
    COCOON_GIT_HARDEN: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: '/bin/false',
  };
}

export function parseGithubRepo(url: string): { owner: string; repo: string } | undefined {
  // github.com must be the host: https://github.com/o/r, ssh://git@github.com/o/r, git@github.com:o/r – not a path or a subdomain.
  const match = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}
