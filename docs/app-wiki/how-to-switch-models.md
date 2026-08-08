## How to Switch Models in a Conversation

Each chat thread in amazing-hashbrown has its own provider and model setting. You can switch at any time — mid-conversation if you like — and the change applies only to that thread going forward.

### Switching During a Conversation

At the bottom of the chat panel, next to the message input bar, you will see a model selector showing the current provider and model name. Click it to open a dropdown listing all configured providers and the models available from each.

Select any model from the list. The next message you send will use that model. Previous messages in the thread are unaffected.

### Viewing Model History

Because the selected model is recorded on each assistant message, you can always see which model generated a specific response. This is useful when you've switched models mid-thread and want to know which one produced a particular answer.

### Setting the Default for New Threads

When you start a new conversation, the thread is initialized with the global default provider and model. To change that default:

- **Settings UI**: go to **Settings → General** and update the default provider.
- **config.yaml**: set `defaultProvider` to the name of the provider you want (the `defaultModel` within that provider's config becomes the starting model).

See [[How to Add a Provider]] for how providers and their default models are configured.

### Per-Thread vs. Global Changes

| Action | Scope |
|---|---|
| Click model selector in chat | This thread only, from the next message onward |
| Settings → General → Default Provider | All new threads (existing threads unchanged) |
| Edit `defaultProvider` in config.yaml | All new threads (existing threads unchanged) |

### RLM and Background Processes

The model selector controls the model used for your foreground chat. Background processes — such as the AfterAgent pipeline and the Retrieval Loop Model (RLM) — may use different models as configured separately. See [[AfterAgent Configuration]] and [[Retrieval Loop Model (RLM) Configuration]] for those settings.

### Tips

- If you're on a slow connection or have limited budget, switch to a smaller or local model for exploratory questions and save a larger model for tasks that need more reasoning power.
- You can configure separate Ollama and cloud providers so you always have a local fallback. See [[How to Set Up Ollama]].
