/** Compact visual reference; full path remains available as a tooltip. */
export function markdownReviewLocation(path: string, startLine: number, endLine: number): string {
  const file = path.split(/[\\/]/).pop() || path;
  const characters = Array.from(file);
  const shortName = characters.length > 10 ? `${characters.slice(0, 10).join('')}…` : file;
  return `${shortName} ${startLine}:${endLine}`;
}
