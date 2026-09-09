---
title: amazing-hashbrown
layout: home.njk
nav:
  - label: Docs
    href: /docs/getting-started/
  - label: GitHub
    href: https://github.com/tkottke90/amazing-hashbrown
hero:
  eyebrow: Open Source · Local-First
  headline: Give your local LLM a memory it can read — and write.
  subhead: >-
    amazing-hashbrown pairs a ReAct chat agent with an on-disk knowledge base,
    so it can search, learn from, and write back to a structured wiki — all
    running on your own machine against a local inference backend like Ollama.
  installCmd: curl -fsSL https://raw.githubusercontent.com/tkottke90/amazing-hashbrown/main/scripts/install.sh | sh
  primaryCta: Get Started
  primaryHref: /docs/getting-started/
  secondaryCta: View on GitHub
  secondaryHref: https://github.com/tkottke90/amazing-hashbrown
features:
  - tag: 01 · Wiki
    title: LLM Wiki
    body: >-
      Knowledge lives in an on-disk knowledge base the agent searches and
      reads on demand, instead of being pre-loaded into the system prompt.
  - tag: 02 · RLM
    title: Retrieval Loop Model
    body: Long documents are queried iteratively rather than stuffed into context wholesale.
  - tag: 03 · Tools
    title: Skill-Gated Tools
    body: >-
      Tools for a specific, less-common capability are only exposed to the
      model once the matching skill is invoked.
footer:
  links:
    - label: Getting Started
      href: /docs/getting-started/
    - label: GitHub
      href: https://github.com/tkottke90/amazing-hashbrown
---
