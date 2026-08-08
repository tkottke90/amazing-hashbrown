# web_fetch Tool

The `web_fetch` tool fetches a URL and returns the page content in **reader mode**: clean text, links, metadata, and a heading outline — stripped of navigation bars, ads, cookie banners, and other clutter. The agent uses this to read documentation, articles, GitHub issues, changelogs, or any public web page.

## Key Behaviors

### Reader Mode

Rather than handing the model raw HTML, the tool extracts the main article content and discards boilerplate. This means the agent gets the text it actually needs at a fraction of the token cost, and you get faster, more focused responses.

### robots.txt Compliance

By default, the tool checks `robots.txt` before fetching. If the URL is disallowed by the site's robots rules, the tool declines to fetch and tells the agent so.

To disable this check (e.g. for internal or private URLs that don't publish a `robots.txt`):

```yaml
webFetch:
  respectRobotsTxt: false
```

### Timeout

Requests time out after `webFetch.timeoutMs` milliseconds. The default is 10,000ms (10 seconds). If you're regularly hitting slow documentation sites, increase this:

```yaml
webFetch:
  timeoutMs: 20000
```

### Link Extraction

The tool returns the list of links found on the page alongside the content. The agent can follow these links for multi-page research — reading a table of contents, then fetching individual sections, for example.

## Limitations

- **No JavaScript execution.** The tool does not run JavaScript, so single-page applications (SPAs) and dynamically-rendered content may appear incomplete or empty. If a page requires JS to render, try finding a static or printer-friendly version.
- **No authentication.** The tool can only access pages that are publicly reachable without logging in.

For the full set of configuration options, see [[Config Web Fetch]].
