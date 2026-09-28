// A failed API call. `message` is the API's `error` summary; `fieldErrors`
// (when the API sends them) are per-field messages, e.g. keyed "env.PATH" for
// one row of the shell_exec env editor, so forms can show them in place.
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      fieldErrors?: Record<string, string[]>;
    };
    throw new RequestError(
      body.error ?? `Request failed: ${res.status}`,
      res.status,
      body.fieldErrors,
    );
  }
  return res.json() as Promise<T>;
}
