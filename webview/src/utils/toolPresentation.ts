import type { ToolInput, ToolResultBlock } from '../types';
import { getFileName, truncate } from './helpers';
import { extractFilePathFromCommand, isCommandToolName, unwrapShellCommand } from './toolCommandPath';
import { normalizeToolInput } from './toolInputNormalization';
import { normalizeToolName } from './toolConstants';

const SPECIAL_FILES = new Set([
  'makefile', 'dockerfile', 'jenkinsfile', 'vagrantfile',
  'gemfile', 'rakefile', 'procfile', 'guardfile',
  'license', 'licence', 'readme', 'changelog',
  'gradlew', 'cname', 'authors', 'contributors',
]);

const stripLineSuffix = (filePath: string): string => filePath.replace(/:\d+(-\d+)?$/, '');

const parseLineSuffix = (filePath?: string): { start?: number; end?: number } => {
  if (!filePath) {
    return {};
  }

  const match = filePath.match(/:(\d+)(?:-(\d+))?$/);
  if (!match) {
    return {};
  }

  return {
    start: Number(match[1]),
    end: match[2] ? Number(match[2]) : undefined,
  };
};

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
};

const extractToolResultText = (result?: ToolResultBlock | null): string | undefined => {
  if (!result) {
    return undefined;
  }

  if (typeof result.content === 'string') {
    return result.content;
  }

  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }

  return undefined;
};

const parseUnifiedDiffFirstHunk = (text?: string): { start?: number; end?: number } => {
  if (!text) {
    return {};
  }

  const lines = text.split(/\r?\n/);
  const hunkHeaderIndex = lines.findIndex((line) => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line));
  if (hunkHeaderIndex === -1) {
    return {};
  }

  const header = lines[hunkHeaderIndex];
  const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) {
    return {};
  }

  const oldStart = Number(match[1]);
  const oldCount = match[2] ? Number(match[2]) : 1;
  const newStart = Number(match[3]);
  const newCount = match[4] ? Number(match[4]) : 1;

  let oldLine = oldStart;
  let newLine = newStart;
  let contextLineCount = 0;
  const addedLines: number[] = [];
  const deletedLines: number[] = [];

  for (let index = hunkHeaderIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line)) {
      break;
    }
    if (!line) {
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) {
      continue;
    }
    if (line.startsWith('+')) {
      addedLines.push(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      deletedLines.push(oldLine);
      oldLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      contextLineCount += 1;
      oldLine += 1;
      newLine += 1;
    }
  }

  if (addedLines.length > 0 && deletedLines.length === 0) {
    return {
      start: addedLines[0],
      end: addedLines.length > 1 ? addedLines[addedLines.length - 1] : undefined,
    };
  }

  if (deletedLines.length > 0 && addedLines.length === 0) {
    return {
      start: deletedLines[0],
      end: deletedLines.length > 1 ? deletedLines[deletedLines.length - 1] : undefined,
    };
  }

  if (addedLines.length > 0 && deletedLines.length > 0 && contextLineCount > 0) {
    return {
      start: addedLines[0],
      end: addedLines.length > 1 ? addedLines[addedLines.length - 1] : undefined,
    };
  }

  const start = oldCount > 0 ? oldStart : newStart;
  const effectiveCount = oldCount > 0 ? oldCount : newCount;

  return {
    start,
    end: effectiveCount > 1 ? start + effectiveCount - 1 : undefined,
  };
};

const relativizeDisplayPath = (filePath: string, workdir?: string): string => {
  const cleanPath = stripLineSuffix(filePath);

  // If absolute path with workdir, try to relativize
  if (workdir && cleanPath.startsWith('/') && workdir.startsWith('/')) {
    if (cleanPath === workdir) {
      return filePath.startsWith(cleanPath) ? './' : '.';
    }

    const normalizedWorkdir = workdir.endsWith('/') ? workdir : `${workdir}/`;
    if (cleanPath.startsWith(normalizedWorkdir)) {
      const relativePath = cleanPath.slice(normalizedWorkdir.length);
      const lineSuffix = filePath.slice(cleanPath.length);
      return `${relativePath}${lineSuffix}`;
    }
  }

  // For relative paths or paths that cannot be relativized, just return the file name
  return getFileName(filePath);
};

const detectDirectory = (filePath: string): boolean => {
  if (filePath === '.' || filePath === '..' || filePath.endsWith('/')) {
    return true;
  }

  const cleanFileName = getFileName(stripLineSuffix(filePath));
  return !cleanFileName.includes('.') && !SPECIAL_FILES.has(cleanFileName.toLowerCase());
};

/**
 * Extract file paths from apply_patch input
 */
export const extractPathsFromPatch = (patchContent: string): string[] => {
  const paths: string[] = [];
  const lines = patchContent.split('\n');

  for (const line of lines) {
    // Match "*** Add File: /path/to/file" or "*** Update File: /path/to/file"
    const match = line.match(/^\*\*\* (?:Add|Update) File:\s*(.+)$/);
    if (match) {
      paths.push(match[1].trim());
    }
  }

  return paths;
};

export interface ToolTargetInfo {
  rawPath: string;
  openPath: string;
  displayPath: string;
  fileName: string;
  cleanFileName: string;
  isDirectory: boolean;
  isFile: boolean;
  lineStart?: number;
  lineEnd?: number;
}

export const resolveToolTarget = (input: ToolInput, name?: string): ToolTargetInfo | undefined => {
  const normalizedInput = normalizeToolInput(name, input) ?? input;
  const workdir = typeof input.workdir === 'string' ? input.workdir : undefined;
  const standardPath =
    (typeof normalizedInput.file_path === 'string' ? normalizedInput.file_path : undefined) ??
    (typeof normalizedInput.path === 'string' ? normalizedInput.path : undefined) ??
    (typeof normalizedInput.target_file === 'string' ? normalizedInput.target_file : undefined) ??
    (typeof normalizedInput.notebook_path === 'string' ? normalizedInput.notebook_path : undefined);

  const lowerName = normalizeToolName(name ?? '');

  // Handle apply_patch tool - extract file path from patch content
  if (lowerName === 'apply_patch') {
    const patchContent = (typeof normalizedInput.input === 'string' ? normalizedInput.input : undefined) ??
      (typeof normalizedInput.patch === 'string' ? normalizedInput.patch : undefined) ??
      (typeof normalizedInput.content === 'string' ? normalizedInput.content : undefined);

    if (patchContent) {
      const paths = extractPathsFromPatch(patchContent);
      if (paths.length > 0) {
        const rawPath = paths[0];
        const { start, end } = parseLineSuffix(rawPath);
        const openPath = stripLineSuffix(rawPath);
        const displayPath = relativizeDisplayPath(rawPath, workdir);
        const fileName = getFileName(displayPath);
        const cleanFileName = getFileName(stripLineSuffix(displayPath));
        const isDirectory = detectDirectory(rawPath);

        return {
          rawPath,
          openPath,
          displayPath: paths.length > 1 ? `${cleanFileName} (+${paths.length - 1} more)` : displayPath,
          fileName,
          cleanFileName,
          isDirectory,
          isFile: !isDirectory,
          lineStart: start,
          lineEnd: end,
        };
      }
    }
  }

  // Command-executing tools that may contain file paths
  const isCommandTool = lowerName === 'read' ||
    lowerName === 'write' ||
    isCommandToolName(lowerName);

  // Codex uses 'cmd', others use 'command'
  const commandStr = (typeof normalizedInput.command === 'string' ? normalizedInput.command : undefined) ??
    (typeof normalizedInput.cmd === 'string' ? normalizedInput.cmd : undefined);

  const rawPath = standardPath ??
    ((isCommandTool && commandStr)
      ? extractFilePathFromCommand(commandStr, workdir)
      : undefined);

  if (!rawPath) {
    return undefined;
  }

  const { start, end } = parseLineSuffix(rawPath);
  const openPath = stripLineSuffix(rawPath);
  const displayPath = relativizeDisplayPath(rawPath, workdir);
  const fileName = getFileName(displayPath);
  const cleanFileName = getFileName(stripLineSuffix(displayPath));
  const isDirectory = detectDirectory(rawPath);

  return {
    rawPath,
    openPath,
    displayPath,
    fileName,
    cleanFileName,
    isDirectory,
    isFile: !isDirectory,
    lineStart: start,
    lineEnd: end,
  };
};

export const getToolLineInfo = (
  input: ToolInput,
  target?: ToolTargetInfo,
  result?: ToolResultBlock | null,
): { start?: number; end?: number } => {
  const offset = parseNumber(input.offset);
  const limit = parseNumber(input.limit);
  if (offset !== undefined && limit !== undefined) {
    return {
      start: offset + 1,
      end: offset + limit,
    };
  }

  const line = input.line ?? input.lines;
  const lineNum = parseNumber(line);
  if (lineNum !== undefined) {
    return { start: lineNum };
  }

  const startLine = parseNumber(input.start_line);
  const endLine = parseNumber(input.end_line);
  if (startLine !== undefined) {
    return { start: startLine, end: endLine };
  }

  const resultLineInfo = parseUnifiedDiffFirstHunk(extractToolResultText(result));
  if (resultLineInfo.start !== undefined) {
    return resultLineInfo;
  }

  return {
    start: target?.lineStart,
    end: target?.lineEnd,
  };
};

export const getToolEditCount = (input: ToolInput): number => {
  const edits = input.edits;
  if (!Array.isArray(edits)) {
    return 0;
  }
  return edits.filter((item) => item && typeof item === 'object').length;
};

export const summarizeToolCommand = (command?: string): string | undefined => {
  if (!command || typeof command !== 'string') {
    return undefined;
  }

  const strippedCommand = unwrapShellCommand(command);
  const firstLine = strippedCommand.split('\n')[0]?.trim() ?? '';
  if (!firstLine) {
    return undefined;
  }

  const summary = strippedCommand.includes('\n') ? `${firstLine} ...` : firstLine;
  return truncate(summary, 80);
};
