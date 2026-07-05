import { Home, Settings } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  ChatMessage,
  ChatMessageCopyAction,
  ChatMessageForkAction,
  ChatMessageSaveAction,
} from '@/components/chat-message';

const USER_MSG = `How do I configure a new persona in the knowledge base?`;

const ASSISTANT_MSG = `To add a new persona, create a YAML file under \`personas/\` with the following fields:

\`\`\`yaml
name: Aria
role: Customer Support Specialist
tone: Friendly and concise
knowledge:
  - product_faq.md
  - return_policy.md
\`\`\`

Then restart the agent harness — it will auto-index the new persona and make it available in the model selector. You can also hot-reload during development with \`npm run harness:reload\`.`;

const SENT_YESTERDAY = new Date(Date.now() - 25 * 60 * 60_000);
const SENT_RECENTLY = new Date(Date.now() - 5 * 60_000);

function AppAside() {
  return (
    <nav className="flex flex-col gap-1 p-4">
      <a
        href="#"
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-sidebar-accent"
      >
        <Home className="size-4" />
        Home
      </a>
      <a
        href="#"
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-sidebar-accent"
      >
        <Settings className="size-4" />
        Settings
      </a>
    </nav>
  );
}

export function App() {
  return (
    <Layout aside={<AppAside />} navEnd={<ThemeToggle />}>
      <div className="p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Amazing Hashbrown</h1>
            <p className="text-muted-foreground">
              Local LLM agent harness — persona knowledge base and autonomous assistant.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="flex flex-col gap-4 px-4 pb-8">
        <ChatMessage
          message={USER_MSG}
          sentAt={SENT_YESTERDAY}
          mirrored
          className="self-end"
          actions={
            <>
              <ChatMessageCopyAction content={USER_MSG} />
              <ChatMessageForkAction />
              <ChatMessageSaveAction content={USER_MSG} />
            </>
          }
        />
        <ChatMessage
          message={ASSISTANT_MSG}
          sentAt={SENT_RECENTLY}
          mirrored
          cost={{ tokensPerSecond: 43.2, dollars: 0.0082 }}
          duration={1800}
          actions={
            <>
              <ChatMessageCopyAction content={ASSISTANT_MSG} />
              <ChatMessageForkAction />
              <ChatMessageSaveAction content={ASSISTANT_MSG} />
            </>
          }
        />
      </div>
    </Layout>
  );
}
