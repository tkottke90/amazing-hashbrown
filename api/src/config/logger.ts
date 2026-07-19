import { configureFromSchema } from '@tkottke90/logger';
import { env } from './env.js';

export const logger = configureFromSchema('amazing-hashbrown-api', {
  level: env.logLevel,
  console: { enabled: true },
});

// The console transport JSON.stringify()s log metadata directly (see
// @tkottke90/logger's winston.format.printf), and `name`/`message`/`stack`
// are all non-enumerable own properties on Error instances — so passing a
// raw Error as metadata silently serializes to `{}`. Log `serializeError(err)`
// instead of a bare `err` anywhere a catch-block error is attached to a log
// call, so the message and stack trace actually make it into the output.
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined ? { cause: err.cause } : {}),
    };
  }
  return { value: err };
}
