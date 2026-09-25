---
title: llms.txt
description: These docs as plain text, for LLMs and coding agents.
---

The whole documentation site is also published as plain Markdown, following
the [llms.txt](https://llmstxt.org/) convention. Point an agent at one of
these instead of making it scrape HTML:

| File | Contents |
|---|---|
| [`/orbital/llms.txt`](/orbital/llms.txt) | An index: what Orbital is, plus links to the other files |
| [`/orbital/llms-full.txt`](/orbital/llms-full.txt) | Every page, in full |
| [`/orbital/llms-small.txt`](/orbital/llms-small.txt) | Every page, with notes and whitespace trimmed for smaller context windows |
| [`/orbital/_llms-txt/for-agents.txt`](/orbital/_llms-txt/for-agents.txt) | Only the agent-facing pages and the CLI reference |

The files are regenerated on every build, so they always match the site.

## Giving an agent the docs

To have an agent set up or troubleshoot Orbital for you:

```text
Read https://jimbuck.github.io/orbital/llms-full.txt, then help me configure
Orbital's status hooks for my work Claude profile.
```

An agent running *inside* Orbital doesn't need any of this. It has
`orbital help`, and its briefing or [the orbital skill](/orbital/agents/skill/)
already covers the CLI.
