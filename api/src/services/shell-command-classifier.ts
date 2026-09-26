// Heuristic classification of a shell_exec command into read/write/other
// file-op fragments — a directional signal for the shell-vs-tool file-op
// adoption metric, not a precise measurement. A single shell_exec call is
// frequently a chain ("cat file.txt && sed -i 's/x/y/' file.txt"), so this
// returns three independent booleans rather than one category: a command can
// be a real file read AND a real file write AND something else, all at once.
//
// Tuning the verb list beyond this starting set is expected once there's
// real shell_audit_log data to check it against — deliberately not trying
// to get it perfect up front.
export interface ShellCommandClassification {
  isFileRead: boolean;
  isFileWrite: boolean;
  isOther: boolean;
}

const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'find']);
const WRITE_VERBS = new Set(['patch', 'sed', 'tee', 'cp', 'mv', 'touch', 'rm']);

function classifyFragment(fragment: string): 'read' | 'write' | 'other' {
  const trimmed = fragment.trim();
  if (!trimmed) return 'other';

  if (/(^|\s)(>>?)(\s|$)/.test(trimmed)) return 'write';

  const verb = trimmed.split(/\s+/)[0];
  if (!verb) return 'other';
  if (READ_VERBS.has(verb)) return 'read';
  if (WRITE_VERBS.has(verb)) return 'write';
  return 'other';
}

export function classifyShellCommand(command: string): ShellCommandClassification {
  const fragments = command.split(/&&|\|\||[|;]/);

  const result: ShellCommandClassification = {
    isFileRead: false,
    isFileWrite: false,
    isOther: false,
  };

  for (const fragment of fragments) {
    switch (classifyFragment(fragment)) {
      case 'read':
        result.isFileRead = true;
        break;
      case 'write':
        result.isFileWrite = true;
        break;
      case 'other':
        result.isOther = true;
        break;
    }
  }

  return result;
}
