# How the Chat Agent Works

The chat agent uses a **ReAct (Reasoning + Acting)** loop to respond to your messages. Rather than generating a reply in one shot, it reasons about what to do, acts by calling tools, and then reasons again based on the results — repeating until it has a complete answer to stream back to you.

## The ReAct Loop

When you send a message, the agent goes through these steps:

1. **Reason** — the model reads your message and its current context, then decides what action to take next.
2. **Act** — if a tool call is needed (e.g. searching the wiki, fetching a web page, running a shell command), the agent invokes it.
3. **Observe** — the tool returns a result, which the agent reads.
4. **Repeat** — the agent reasons again with the new information, and calls more tools if necessary.
5. **Respond** — once the agent has enough to answer, it streams its final reply to you.

A single message can trigger multiple tool calls before you see a response. While the agent is working, each tool call appears as a collapsible chip in the message thread so you can follow along.

## Built-in Tools

The agent has access to **17 built-in tools** covering:

- **Wiki read/write** — reading and updating the knowledge base
- **Shell execution** — running bash commands in a controlled environment
- **Web fetching** — retrieving and reading web pages in reader mode
- **Image upload** — attaching images to messages or wiki pages
- **Human-in-the-loop prompts** — pausing to ask you questions when needed

You can extend the agent's capabilities by connecting **MCP servers**, which expose additional tools. See [[How MCP Works]].

## Automatic Wiki Consultation

Before responding to any substantive question, the agent automatically searches the wiki for relevant context — you don't need to ask it to. This means answers are grounded in your accumulated knowledge base, not just the model's training data.

## What Happens After Each Turn

Once the agent's reply is complete, the [[AfterAgent Pipeline]] kicks off in the background to extract and save anything worth keeping to the wiki.
