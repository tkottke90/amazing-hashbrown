# AfterAgent Pipeline

The AfterAgent pipeline is a four-step background process that runs automatically after every chat turn. While it runs, the UI shows a **"Working in the background…"** spinner in the thread sidebar. When it finishes, you'll see either **"Added to knowledge base"** or **"Nothing new to save."**

## The Four Steps

### Step 1 — Summarize

The full turn — your message, the agent's response, and any tool activity — is condensed into a compact representation. This summary is what the later steps operate on, keeping token usage low.

### Step 2 — Classify

A second LLM call evaluates whether the turn contains novel, wiki-worthy information. Routine exchanges are skipped:

- Greetings and small talk
- Simple clarifications or corrections
- Procedural back-and-forth (e.g. "try again", "make it shorter")

Only turns with genuinely new facts, decisions, or knowledge pass through to the next step.

### Step 3 — Extract

If the turn is classified as wiki-worthy, its content is structured into one or more **wiki page drafts**. Each draft includes:

- **Type** — entity, concept, query, or source
- **Title** — a normalized, human-readable page title
- **Tags** — inferred from context and domain
- **Body** — the page content in wiki markdown
- **Source references** — linking back to the originating thread and turn

### Step 4 — Commit

The drafts are written to the wiki. The pipeline checks for existing pages with the same title or closely matching content, and merges intelligently rather than creating duplicates. New pages are created when no match is found.

## Disabling the Pipeline

To turn off AfterAgent processing entirely, set the following in `config.yaml`:

```yaml
afterAgent:
  enabled: false
```

Individual steps can also be tuned — see [[Config AfterAgent]] for the full configuration reference.

For more on how extracted content lands in the wiki, see [[AfterAgent and the Knowledge Base]].
