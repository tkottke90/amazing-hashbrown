import { ThemeToggle } from '@/components/theme-toggle';

export function App() {
  return (
    <main className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Amazing Hashbrown</h1>
          <p className="text-muted-foreground">
            Local LLM agent harness — persona knowledge base and autonomous assistant.
          </p>
        </div>
        <ThemeToggle />
      </div>
    </main>
  );
}
