/** Accept only literal, empty-input terminal polls; never execute or hide mixed scripts. */
export function isPollingOnlyScript(script: string): boolean {
  let masked = '';
  for (let index = 0; index < script.length;) {
    const char = script[index];
    if (char === '`') return false;
    if (char === '"' || char === "'") {
      let value = '';
      const quote = char;
      index += 1;
      while (index < script.length && script[index] !== quote) {
        if (script[index] === '\\') value += script[index++];
        value += script[index++];
      }
      if (index >= script.length) return false;
      masked += value === 'chars' ? 'chars' : value ? '"value"' : '""';
      index += 1;
    } else if (script.startsWith('//', index)) {
      const end = script.indexOf('\n', index + 2);
      index = end < 0 ? script.length : end;
      masked += ' ';
    } else if (script.startsWith('/*', index)) {
      const end = script.indexOf('*/', index + 2);
      if (end < 0) return false;
      index = end + 2;
      masked += ' ';
    } else {
      masked += char;
      index += 1;
    }
  }
  // A nonempty chars argument writes to the terminal and must remain visible.
  if (/\bchars\s*:\s*"value"/.test(masked)) return false;
  const literal = '(?:-?\\d+(?:\\.\\d+)?|"(?:value)?"|true|false|null)';
  const property = `(?:[A-Za-z_$][\\w$]*|"value")\\s*:\\s*${literal}`;
  const object = `\\{\\s*(?:${property}(?:\\s*,\\s*${property})*\\s*,?)?\\s*\\}`;
  const call = `(?:await\\s+)?(?:tools|functions)\\s*\\.\\s*write_stdin\\s*\\(\\s*${object}\\s*\\)`;
  return new RegExp(`^\\s*(?:(?:text\\s*\\(\\s*${call}\\s*\\)|${call})\\s*;?\\s*)+$`).test(masked);
}
