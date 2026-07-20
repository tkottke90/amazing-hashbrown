# upload-playwright-report

Uploads a Playwright HTML report to an S3-compatible bucket so it can be
viewed directly in a browser via a CDN, instead of downloading and unzipping
a GitHub Actions artifact.

## Usage

```yaml
- name: Upload Playwright report to S3
  id: upload-s3-report
  if: always()
  continue-on-error: true
  uses: ./.github/actions/upload-playwright-report
  with:
    report-dir: e2e/playwright-report
    bucket-url: ${{ vars.PLAYWRIGHT_REPORT_BUCKET_URL }}
    public-url: ${{ vars.PLAYWRIGHT_REPORT_PUBLIC_URL }}
    aws-access-key-id: ${{ secrets.PLAYWRIGHT_REPORT_AWS_ACCESS_KEY_ID }}
    aws-secret-access-key: ${{ secrets.PLAYWRIGHT_REPORT_AWS_SECRET_ACCESS_KEY }}
    aws-region: ${{ vars.PLAYWRIGHT_REPORT_AWS_REGION || 'us-east-1' }}
    repo-name: ${{ github.event.repository.name }}
    commit-sha: ${{ github.sha }}
    ttl-days: ${{ vars.PLAYWRIGHT_REPORT_TTL_DAYS || '5' }}
```

The uploaded report's URL is exposed as `steps.upload-s3-report.outputs.report-url`.

## `bucket-url` and `public-url`

By default, `bucket-url` is used for two things:

1. The S3 API endpoint the action uploads to (`--endpoint-url`).
2. The base of the public URL returned in `report-url`.

This means the bucket must be reachable at the **same origin** for both the
S3 API and public GET requests, using path-style addressing
(`https://host/bucket-name/key`, not `https://bucket-name.host/key`). This
works for most self-hosted setups (e.g. MinIO behind a reverse proxy/CDN)
and providers that support path-style access at a public domain.

If your upload endpoint doesn't support GET at all — e.g. a domain locked
down to PUT/POST only — set `public-url` to a different domain that fronts
the same bucket and does allow GET (an internal CDN, a VPN-only reverse
proxy, etc). When set, `public-url` replaces `bucket-url` **only** for
building the `report-url` link; uploads still go to `bucket-url`. Give it
whatever path a browser would need to GET an object from that domain (e.g.
include the bucket-name segment too, unless the fronting domain already
rewrites/strips it) — same format as `bucket-url`, just a different host:

```
public-url: https://finance.example.com/
```

If `public-url` is not set, `report-url` falls back to `bucket-url`, so a
provider whose upload/public domains are already the same (e.g. Cloudflare
R2's native API host vs. a custom public domain both fronted by one CDN,
or plain MinIO/path-style setups) doesn't need to set it at all.

## TTL and object expiry

This action does **not** delete anything and does **not** touch the
bucket's lifecycle configuration. On every upload, it tags each object with:

```
<ttl-tag-key>=<YYYY-MM-DD>
```

(default tag key `expires-on`, default TTL 5 days, both configurable via
inputs). The tag value is the date the object should expire.

**You must separately configure a lifecycle rule on the bucket** (one-time,
outside CI) that deletes objects matching that tag — for example, an S3
lifecycle rule filtering on tag `expires-on` with an expiration action.
Until that rule exists, uploaded reports will accumulate indefinitely.

## Required GitHub Actions configuration

**Variables** (Settings → Secrets and variables → Actions → Variables):

| Name                           | Required                     | Example                                |
| ------------------------------ | ---------------------------- | -------------------------------------- |
| `PLAYWRIGHT_REPORT_BUCKET_URL` | yes                          | `https://cdn.example.com/ci-artifacts` |
| `PLAYWRIGHT_REPORT_PUBLIC_URL` | no                           | `https://finance.example.com/`         |
| `PLAYWRIGHT_REPORT_AWS_REGION` | no (defaults to `us-east-1`) | `auto`                                 |
| `PLAYWRIGHT_REPORT_TTL_DAYS`   | no (defaults to `5`)         | `5`                                    |

**Secrets**:

| Name                                      | Required |
| ----------------------------------------- | -------- |
| `PLAYWRIGHT_REPORT_AWS_ACCESS_KEY_ID`     | yes      |
| `PLAYWRIGHT_REPORT_AWS_SECRET_ACCESS_KEY` | yes      |
