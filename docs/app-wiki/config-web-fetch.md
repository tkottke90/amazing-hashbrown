## Web Fetch Configuration

The `web_fetch` tool allows the agent to retrieve content from URLs during a conversation. Its behavior is controlled by the `webFetch` section of `config.yaml`.

### Configuration Section

```yaml
webFetch:
  timeoutMs: 10000
  respectRobotsTxt: true
```

### Settings Reference

**`timeoutMs`** (default: `10000`)

How long the tool waits for an HTTP response before giving up, in milliseconds. The default is 10 seconds (10,000 ms).

Increase this if the agent is frequently timing out on slow or large pages. Decrease it if you want the agent to fail fast and move on when a URL is unresponsive.

```yaml
webFetch:
  timeoutMs: 30000   # wait up to 30 seconds
```

**`respectRobotsTxt`** (default: `true`)

When `true`, before fetching any URL the tool checks the site's `robots.txt` file and refuses to fetch the page if the rules disallow crawling.

Set to `false` to bypass this check and fetch any URL regardless of robots.txt directives:

```yaml
webFetch:
  respectRobotsTxt: false
```

Use this only when you have a legitimate reason to access pages that robots.txt would otherwise exclude — for example, fetching content from your own internal services where robots.txt rules are not meaningful.

### When the Tool Is Invoked

The agent uses `web_fetch` any time it needs to read external content — fetching documentation, looking up a reference, reading a linked article you share in chat, and so on. The tool is part of the agent's standard toolkit and does not require explicit user permission per call (though a shell-based fetch would). Only the configuration limits above govern its behavior.

See [[web_fetch Tool]] for a full description of what the tool does and how the agent decides to use it.
