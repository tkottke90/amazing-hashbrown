// A minimal glob matcher — no glob dependency exists anywhere in this repo
// today, and adding one for a single tool didn't seem worth it. Supports the
// common cases only: "*" (any run of characters except "/"), "**" (any run
// of characters including "/"), and "?" (a single character except "/").
// Not a full glob implementation (no brace expansion, no character classes)
// — sufficient for find_file's "*.ts" / "**/*.test.ts" style patterns.
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c && '.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
