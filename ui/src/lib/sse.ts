import { ChatSSEEventSchema, type ChatSSEEvent } from '@tkottke90/llm-common-types/chat';

export async function consumeSsePost(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: ChatSSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim();
        if (!raw) continue;
        const parsed = ChatSSEEventSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          onEvent(parsed.data);
        }
      }
    }
  }
}
