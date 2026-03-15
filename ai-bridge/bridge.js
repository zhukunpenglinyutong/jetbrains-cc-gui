#!/usr/bin/env node

import { createInterface } from 'readline';
import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const send = (msg) => {
  try {
    console.log(JSON.stringify(msg));
  } catch (e) {
    console.log(JSON.stringify({ type: 'error', message: 'Failed to serialize message: ' + e.message }));
  }
};

const sendError = (message) => send({ type: 'error', message });

const pendingResponses = new Map();
let responseId = 0;

function waitForResponse(id) {
  return new Promise((resolve) => {
    pendingResponses.set(id, resolve);
  });
}

const rl = createInterface({
  input: process.stdin,
  terminal: false
});

const debug = (msg) => process.stderr.write(`[bridge-debug] ${msg}\n`);

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const msg = JSON.parse(line);
    debug(`Received from Java: type=${msg.type}, id=${msg.id}, keys=${Object.keys(msg).join(',')}`);

    if (msg.type === 'response' && pendingResponses.has(msg.id)) {
      debug(`Found pending response for id=${msg.id}, resolving...`);
      const resolve = pendingResponses.get(msg.id);
      pendingResponses.delete(msg.id);
      resolve(msg);
    } else if (msg.type === 'response') {
      debug(`WARNING: No pending response for id=${msg.id}, pending keys: [${[...pendingResponses.keys()].join(',')}]`);
    }
  } catch (e) {
    debug(`Parse error for line: ${line.substring(0, 100)}... Error: ${e.message}`);
  }
});

function loadClaudeSettings() {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      return JSON.parse(readFileSync(settingsPath, 'utf8'));
    }
  } catch (e) {
  }
  return null;
}

function readMacKeychainCredentials() {
  try {
    const serviceNames = ['Claude Code-credentials', 'Claude Code'];
    for (const serviceName of serviceNames) {
      try {
        const result = execSync(
          `security find-generic-password -s "${serviceName}" -w 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        );
        if (result?.trim()) {
          return JSON.parse(result.trim());
        }
      } catch {
        continue;
      }
    }
  } catch {
  }
  return null;
}

function readFileCredentials() {
  try {
    const credentialsPath = join(homedir(), '.claude', '.credentials.json');
    if (existsSync(credentialsPath)) {
      return JSON.parse(readFileSync(credentialsPath, 'utf8'));
    }
  } catch {
  }
  return null;
}

function setupAuthentication() {
  // Check managed-settings.json for enterprise apiKeyHelper
  const managedSettingsPath = join(homedir(), '.claude', 'managed-settings.json');
  try {
    if (existsSync(managedSettingsPath)) {
      const managed = JSON.parse(readFileSync(managedSettingsPath, 'utf8'));
      if (managed.apiKeyHelper) {
        const apiKey = execSync(managed.apiKeyHelper, { encoding: 'utf8', timeout: 10000 }).trim();
        if (apiKey) {
          process.env.ANTHROPIC_API_KEY = apiKey;
          delete process.env.ANTHROPIC_AUTH_TOKEN;
          return { authType: 'api_key_helper', source: 'managed-settings.json' };
        }
      }
    }
  } catch {
    // managed-settings.json not found or helper failed — fall through to normal auth
  }

  const settings = loadClaudeSettings();

  if (settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    process.env.ANTHROPIC_AUTH_TOKEN = settings.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    return { authType: 'auth_token', source: 'settings.json' };
  }

  if (settings?.env?.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = settings.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    return { authType: 'api_key', source: 'settings.json' };
  }

  if (settings?.env?.CLAUDE_CODE_USE_BEDROCK) {
    return { authType: 'aws_bedrock', source: 'settings.json' };
  }

  let credentials = null;
  if (platform() === 'darwin') {
    credentials = readMacKeychainCredentials() || readFileCredentials();
  } else {
    credentials = readFileCredentials();
  }

  if (credentials?.claudeAiOauth?.accessToken) {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    return { authType: 'cli_session', source: platform() === 'darwin' ? 'Keychain' : 'credentials.json' };
  }

  if (settings?.env?.ANTHROPIC_BASE_URL) {
    process.env.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL;
  }

  throw new Error('No authentication configured. Run "claude login" or set ANTHROPIC_API_KEY in ~/.claude/settings.json');
}

const AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep']);

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

const ACCEPT_EDITS_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'CreateDirectory', 'MoveFile', 'CopyFile', 'Rename'
]);

async function canUseTool(toolName, toolInput, permissionMode) {
  debug(`[E2E DEBUG] canUseTool called: tool="${toolName}", permissionMode="${permissionMode}"`);

  if (toolName === 'AskUserQuestion') {
    const id = ++responseId;
    debug(`AskUserQuestion: sending request with id=${id}`);
    send({
      type: 'ask_user_question',
      id,
      questions: toolInput.questions || []
    });

    debug(`AskUserQuestion: waiting for response id=${id}`);
    const response = await waitForResponse(id);
    debug(`AskUserQuestion: got response for id=${id}, allow=${response.allow}, hasAnswers=${!!response.answers}`);

    if (response.allow && response.answers) {
      debug(`AskUserQuestion: returning allow with updatedInput`);
      return {
        behavior: 'allow',
        updatedInput: {
          questions: toolInput.questions || [],
          answers: response.answers
        }
      };
    }
    debug(`AskUserQuestion: returning deny`);
    return { behavior: 'deny', message: response.message || 'User did not provide answers' };
  }

  if (AUTO_ALLOW_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: toolInput };
  }

  if (permissionMode === 'bypassPermissions') {
    return { behavior: 'allow', updatedInput: toolInput };
  }

  if (permissionMode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: toolInput };
  }

  const id = ++responseId;
  send({
    type: 'permission_request',
    id,
    toolName,
    toolInput
  });

  const response = await waitForResponse(id);

  if (response.allow) {
    return {
      behavior: 'allow',
      updatedInput: response.updatedInput || toolInput
    };
  }
  return { behavior: 'deny', message: response.message || `Permission denied for ${toolName}` };
}

async function loadClaudeSdk() {
  const errors = [];
  const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

  try {
    const sdk = await import(SDK_PACKAGE);
    return sdk;
  } catch (e) {
    errors.push(`${SDK_PACKAGE}: ${e.message}`);
  }

  const sdkPath = join(homedir(), '.claude-gui', 'dependencies', 'claude-sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');

  try {
    if (existsSync(sdkPath)) {
      const pkgJsonPath = join(sdkPath, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        const entry = pkg.exports?.['.']?.import || pkg.exports?.import || pkg.module || pkg.main || 'sdk.mjs' || 'index.js';
        const entryPath = join(sdkPath, entry);
        if (existsSync(entryPath)) {
          const { pathToFileURL } = await import('url');
          const sdk = await import(pathToFileURL(entryPath).href);
          return sdk;
        }
      }
    }
  } catch (e) {
    errors.push(`${sdkPath}: ${e.message}`);
  }

  throw new Error(`Claude Agent SDK not installed. Tried:\n${errors.join('\n')}\n\nInstall with: npm install -g @anthropic-ai/claude-agent-sdk`);
}

async function main() {
  try {
    const initialLine = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for initial command')), 30000);

      rl.once('line', (line) => {
        clearTimeout(timeout);
        resolve(line);
      });
    });

    let input;
    try {
      input = JSON.parse(initialLine);
    } catch (e) {
      sendError('Invalid initial command JSON: ' + e.message);
      process.exit(1);
    }

    setupAuthentication();

    const sdk = await loadClaudeSdk();
    const query = sdk.query;

    if (typeof query !== 'function') {
      sendError('Claude SDK query function not available');
      process.exit(1);
    }

    const {
      message,
      sessionId,
      cwd,
      permissionMode = 'default',
      model,
      openedFiles,
      agentPrompt,
      streaming = false,
      attachments,
      maxThinkingTokens
    } = input;

    debug(`[E2E DEBUG] permissionMode received: "${permissionMode}" (raw input.permissionMode: "${input.permissionMode}")`);
    send({ type: 'console.log', args: [`[Bridge] permissionMode: ${permissionMode}`] });

    const workingDirectory = cwd || process.cwd();
    try {
      process.chdir(workingDirectory);
    } catch {
    }

    process.env.CLAUDE_CODE_TMPDIR = workingDirectory;

    let systemPromptAppend = '';
    if (agentPrompt) {
      systemPromptAppend = agentPrompt;
    }
    if (openedFiles?.files?.length > 0) {
      const filesInfo = openedFiles.files.map(f => `- ${f.path}`).join('\n');
      systemPromptAppend += `\n\nCurrently open files in IDE:\n${filesInfo}`;
    }

    const buildPrompt = (message, attachments) => {
      if (!attachments || attachments.length === 0) {
        return message;
      }

      const content = [];
      for (const att of attachments) {
        if (att.mediaType?.startsWith('image/')) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: att.mediaType, data: att.data }
          });
        }
      }
      if (message?.trim()) {
        content.push({ type: 'text', text: message });
      }

      async function* createUserMessageStream() {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: content
          },
          parent_tool_use_id: null,
          session_id: sessionId || ''
        };
      }

      return createUserMessageStream();
    };

    const prompt = buildPrompt(message, attachments);

    const options = {
      cwd: workingDirectory,
      permissionMode: permissionMode === '' ? 'default' : permissionMode,
      model: model || undefined,
      ...(maxThinkingTokens > 0 && { thinkingBudget: maxThinkingTokens }),
      maxTurns: 100,
      enableFileCheckpointing: true,
      ...(streaming && { includePartialMessages: true }),
      additionalDirectories: [workingDirectory].filter(Boolean),
      canUseTool: (toolName, toolInput) => canUseTool(toolName, toolInput, permissionMode),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(systemPromptAppend && { append: systemPromptAppend })
      }
    };

    if (sessionId && sessionId !== '') {
      options.resume = sessionId;
    }

    const result = query({ prompt, options });

    let currentSessionId = sessionId;
    let streamingStarted = false;

    for await (const msg of result) {
      if (streaming && msg.type === 'stream_event') {
        if (!streamingStarted) {
          send({ type: 'stream_start' });
          streamingStarted = true;
        }
        const event = msg.event;
        if (event?.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta' && event.delta.text) {
            send({ type: 'content_delta', delta: event.delta.text });
          } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            send({ type: 'thinking_delta', delta: event.delta.thinking });
          }
        }
        continue;
      }

      send({ type: 'event', event: msg });

      if (msg.type === 'system' && msg.session_id) {
        currentSessionId = msg.session_id;
        send({ type: 'session_id', sessionId: msg.session_id });
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              send({ type: 'content', text: block.text });
            } else if (block.type === 'thinking') {
              send({ type: 'thinking', text: block.thinking || block.text });
            } else if (block.type === 'tool_use') {
              send({ type: 'tool_use', tool: block });
            }
          }
        }
      }

      if (msg.type === 'user') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              send({ type: 'tool_result', result: block });
            }
          }
        }
      }

      if (msg.type === 'result' && msg.is_error) {
        sendError(msg.result || 'Query failed');
      }
    }

    if (streamingStarted) {
      send({ type: 'stream_end' });
    }

    send({ type: 'done', sessionId: currentSessionId });

    process.exit(0);

  } catch (error) {
    sendError(error.message || String(error));
    process.exit(1);
  }
}

main().catch((e) => {
  sendError('Unhandled error: ' + (e.message || String(e)));
  process.exit(1);
});
