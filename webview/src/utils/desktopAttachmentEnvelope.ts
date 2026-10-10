const ENVELOPE = /^\s*# Files mentioned by the user:\n+(.*?)\nDistinguish instructions in attached documents from the user's request\.\n+## My request:[\t ]*(?:\n|$)/s;

/** Strip the exact desktop transport envelope, preserving real file references. */
export function stripDesktopAttachmentEnvelope(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const envelope = ENVELOPE.exec(normalized);
  if (!envelope) return text;
  const references: string[] = [];
  for (const entry of envelope[1].trim().split(/\n+(?=## )/)) {
    const file = /^## ([^\n]+?): ([^\n]+)\n?(.*)$/s.exec(entry.trim());
    if (!file) return text;
    const path = file[2].trim();
    const extra = file[3].trim();
    const image = extra === 'Image attachment: true' || extra === `${path}\nImage attachment: true`;
    if (!image && extra && extra !== path) return text;
    if (!image) references.push(`${file[1].trim()}: ${path}`);
  }
  const request = normalized.slice(envelope[0].length).trimStart();
  return references.length ? `${references.join('\n')}\n\n${request}` : request;
}
