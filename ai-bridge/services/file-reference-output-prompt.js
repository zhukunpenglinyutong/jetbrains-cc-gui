const FILE_REFERENCE_OUTPUT_PROMPT = `## Clickable File References

When explaining, tracing, reviewing, or summarizing project code, include clickable file references for the concrete files you mention.

For this JetBrains UI, prefer plain-text references in this exact format instead of Markdown file links:
- FileName.ext (line N)
- relative/path/FileName.ext (line N)

Rules:
- Use the real file name or project-relative path and the real 1-based line number.
- Prefer the shortest unambiguous path. If duplicate file names may exist, use the project-relative path.
- Do not abbreviate file paths with "..." when you know the real path.
- For Java classes, include the .java suffix in file references, for example CommunityDomainServiceImpl.java (line 862).
- Place references directly in the explanation sentence or bullet where they are useful.
- Do not put file references inside code blocks or inline code.
- Do not invent file names or line numbers. Omit a reference if you are not sure.
- For ranges, cite the most important starting line as (line N).
- If you know the file but not the line, output the real file name or relative path as plain text outside code formatting.`;

export function buildFileReferenceOutputPrompt() {
  return FILE_REFERENCE_OUTPUT_PROMPT;
}

export function prependFileReferenceOutputPrompt(message) {
  return `<ui-output-instructions>\n${FILE_REFERENCE_OUTPUT_PROMPT}\n</ui-output-instructions>\n\n${message}`;
}
