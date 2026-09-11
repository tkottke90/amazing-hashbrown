---
title: Getting Started
section: LLM Wiki
order: 2
layout: doc.njk
---

## Getting Started

The LLM Wiki isn't one feature with a single obvious first step — it's a platform-level building block that can back the main chat agent's memory, a workspace's project knowledge, or a domain you build by hand for something else entirely. With that many possibilities, the fastest way to understand what it actually does isn't to read about wikis first. It's to have one ordinary conversation with the agent, then go look at what happened.

Ask it something, tell it something about yourself or what you're working on.  Tell it you want to build something or keep track of something.

 When the turn finishes, open the Wiki view. There's a good chance a page already exists that wasn't there before. Nobody asked for that page to be written: the [chat interface](/docs/llm-wiki/004-wiki-chat/) has a built-in reflection step (**AfterAgent**) that runs after every reply and decides on its own whether anything in the conversation was worth keeping. Once you've seen that happen once, everything else the wiki does is a variation on the same idea — content arriving either quietly on your behalf, or explicitly because someone asked for it. For the full picture of when AfterAgent decides to write and how to tune it, see [AfterAgent configuration](/docs/configuration/001-afteragent/).

### Default Wikis

To get the application off the ground, two wikis exist from the moment the app starts, before you create anything yourself:

- **`user`** — facts about you: preferences, personal context, anything the agent has picked up about who it's talking to.
- **`self`** — the agent's own knowledge about itself: its reasoning, decisions, mistakes, and how its behavior has changed over time.

Both are created automatically on first boot. Most of what ends up in them arrives via AfterAgent rather than anything you do directly, so there's nothing to set up — they're just there, quietly filling in as you use the app.

### Creating a Wiki

Beyond the two defaults, a new wiki comes into existence in one of three ways:

1. **Automatically, per workspace.** Every workspace/project gets its own dedicated wiki the moment it's created, scoped to that project and cleaned up when the project is deleted. You don't do anything to make this happen.
2. **By asking for one.** The Wiki view's "New Domain" action opens a chat with a dedicated wiki-ingestion agent — a separate assistant purpose-built for building and maintaining a wiki rather than general conversation. Describe the domain you want, or hand it a URL to pull content from, and it scaffolds and populates it for you.
3. **By importing one.** If you already have a wiki built elsewhere, uploading it as an archive registers the whole thing as a new domain in one step, rather than building it up page by page.

### Add to a Wiki

There's no single "add to wiki" action — content arrives through whichever of these fits the moment:

- **Passively, via AfterAgent** — the default path described above. You just talk; the wiki grows on its own.
- **Explicitly, mid-conversation** — the chat agent can also create or update a wiki page directly when you ask it to, without waiting for AfterAgent's judgment call.
- **Through the wiki-ingestion agent** — better suited to deliberate, bulk work: building out a new domain, pulling in a URL, or cleaning up how pages link to each other.
- **By hand** — every wiki is ultimately just a folder of markdown files on disk. Nothing stops you from editing a page directly in a text editor; if you add or rename a domain folder outside the app, register it from the Wiki view so the app picks it up.
