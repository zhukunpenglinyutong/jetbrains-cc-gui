export type FileIconKind = 'code' | 'file';

/**
 * Shared mapping from a file name (or path) to the CoDriver icon vocabulary.
 * Centralizes the code-extension list previously duplicated in ContextBar and
 * AttachmentList so the two stay in sync.
 */
const CODE_EXTENSIONS = new Set<string>([
  'bat',
  'c',
  'cmd',
  'cpp',
  'cs',
  'css',
  'go',
  'gradle',
  'groovy',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'kts',
  'less',
  'md',
  'properties',
  'py',
  'rs',
  'scss',
  'sh',
  'sql',
  'ts',
  'tsx',
  'xml',
  'yaml',
  'yml',
]);

export function getFileIconKind(fileNameOrPath: string): FileIconKind {
  const extension = extractExtension(fileNameOrPath);
  return CODE_EXTENSIONS.has(extension) ? 'code' : 'file';
}

function extractExtension(fileNameOrPath: string): string {
  const fileName = extractFileName(fileNameOrPath);
  const extensionStart = fileName.lastIndexOf('.');

  if (extensionStart < 0 || extensionStart === fileName.length - 1) {
    return '';
  }

  return fileName.substring(extensionStart + 1).toLowerCase();
}

function extractFileName(fileNameOrPath: string): string {
  return fileNameOrPath.split(/[/\\]/).pop() || fileNameOrPath;
}
