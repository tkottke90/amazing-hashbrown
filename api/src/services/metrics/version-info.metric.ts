import type { Metric } from '../metric.js';

const REPO_URL = 'https://github.com/tkottke90/amazing-hashbrown';
const RELEASES_URL = `${REPO_URL}/releases`;
const GITHUB_RELEASES_API =
  'https://api.github.com/repos/tkottke90/amazing-hashbrown/releases/latest';

interface GithubRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
}

function baseContent(): string {
  const version = process.env['APP_VERSION'] ?? 'unknown';
  const sha = process.env['COMMIT_SHA'] ?? 'unknown';
  const shortSha = sha === 'unknown' ? sha : sha.slice(0, 7);
  return `**Version:** ${version} (\`${shortSha}\`)\n[Repository](${REPO_URL})`;
}

export const versionInfoMetric: Metric = {
  id: 'version-info',
  label: 'Version Info',
  displayType: 'markdown',
  async resolve({ checkForUpdates, fetchImpl }) {
    const base = baseContent();
    const staticFallback = `${base}\n[View Releases](${RELEASES_URL})`;

    if (!checkForUpdates) return { displayType: 'markdown', content: staticFallback };

    try {
      const doFetch = fetchImpl ?? fetch;
      const res = await doFetch(GITHUB_RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
      const release = (await res.json()) as GithubRelease;

      const currentVersion = process.env['APP_VERSION'] ?? 'unknown';
      const latestVersion = release.tag_name.replace(/^v/, '');
      const notice =
        latestVersion !== currentVersion
          ? `⬆️ Newer version available: **${release.tag_name}** (released ${release.published_at.slice(0, 10)}) — [View Release](${release.html_url})`
          : '✅ Up to date';
      return { displayType: 'markdown', content: `${base}\n${notice}` };
    } catch {
      // Never surface the failure — fall back to the static link.
      return { displayType: 'markdown', content: staticFallback };
    }
  },
};
