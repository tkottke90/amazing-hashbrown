// Detects a shell command that waits by sleeping — the pattern an agent
// reaches for when it wants to "check back later" (`sleep 900 && kubectl
// rollout status ...`). A long sleep inside a single tool call holds the
// caller's resources for the whole wait, so callers refuse it and point the
// agent at a real wake-up mechanism instead.
//
// Deliberately a best-effort lexical check, not a shell parser:
// - catches `sleep` used as a command anywhere in a list or pipeline
//   (`;`, `&&`, `||`, `|`, `&`, newlines, `$( )`, backticks, `do`/`then`
//   bodies), GNU duration suffixes (`5m`, `1.5h`), summed arguments
//   (`sleep 1m 30s`) and `timeout <N> sleep ...`;
// - ignores `sleep` inside quoted strings (`echo "sleep 600"`);
// - knowingly misses sleeps inside interpreters or scripts
//   (`python -c 'time.sleep(600)'`, `./wait.sh`).
// See docs/superpowers/specs/2026-09-27-agent-wait-design.md §5.

// Sleeps at or below this many seconds are allowed — a short pause (e.g.
// letting a server finish binding its port) is legitimate.
export const SLEEP_GUARD_THRESHOLD_S = 10;

const UNIT_SECONDS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };

// Shell keywords and grouping tokens that can precede a command word.
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', '{', '(', '!', 'exec', 'nohup', 'time']);

// `timeout` options that consume the following token as their value.
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(['-s', '--signal', '-k', '--kill-after']);

// Returns the total seconds the command sleeps when that exceeds
// SLEEP_GUARD_THRESHOLD_S, otherwise null.
export function detectLongSleep(command: string): number | null {
  let total = 0;
  for (const segment of splitCommands(stripQuoted(command))) {
    total += sleepSeconds(segment.trim().split(/\s+/).filter(Boolean));
  }
  return total > SLEEP_GUARD_THRESHOLD_S ? total : null;
}

// Blanks out single- and double-quoted strings so their contents can never
// be mistaken for a command.
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' "" ');
}

// Splits on list/pipeline operators and treats command substitution as its
// own command.
function splitCommands(command: string): string[] {
  return command.replace(/\$\(|`|\)/g, ';').split(/&&|\|\||[;|&\n]/);
}

function sleepSeconds(tokens: string[]): number {
  // '' past the end — never a keyword, option, `timeout` or `sleep`.
  const at = (k: number): string => tokens[k] ?? '';
  let i = 0;
  while (LEADING_KEYWORDS.has(at(i)) || /^\w+=/.test(at(i))) i++;

  if (at(i) === 'timeout') {
    i++;
    while (at(i).startsWith('-')) {
      i += TIMEOUT_OPTIONS_WITH_VALUE.has(at(i)) ? 2 : 1;
    }
    i++; // timeout's own duration
  }

  if (commandName(at(i)) !== 'sleep') return 0;

  let seconds = 0;
  for (const arg of tokens.slice(i + 1)) {
    const parsed = parseDuration(arg);
    if (parsed === null) break;
    seconds += parsed;
  }
  return seconds;
}

function commandName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

function parseDuration(arg: string): number | null {
  if (arg === 'infinity' || arg === 'inf') return Number.POSITIVE_INFINITY;
  const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(arg);
  if (!match) return null;
  return Number(match[1]) * (UNIT_SECONDS[match[2] ?? ''] ?? 1);
}
