// http.<url-prefix>.extraHeader is git's own conditional-by-host config —
// setting it unconditionally is harmless for a non-GitHub remote (git only
// attaches the header to requests matching that URL prefix), so no
// remote-URL inspection is needed before computing this. Passed as a
// one-off `-c` flag on each invocation: never written to .git/config or
// the remote URL, so it never persists to disk and never shows in `git
// remote -v`. Same technique actions/checkout uses, for the same reason.
//
// No default parameter reading the live config here — kept token-in,
// args-out so this stays importable by tests with zero env/configManager
// coupling; the live `env.workspaces.git?.github?.token` read happens only
// at each call site in workspace-git.ts/workspace-provision.ts.
export function buildGitAuthArgs(token: string | undefined): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraHeader=Authorization: Basic ${basic}`];
}
