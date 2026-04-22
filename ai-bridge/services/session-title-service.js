/**
 * Session title generation service.
 * Generates AI titles for sessions using Haiku API.
 * Follows CLI's generate_session_title flow but runs independently in ai-bridge.
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { setupApiKey, loadClaudeSettings, getCliUserAgent } from '../config/api-config.js';
import { ensureAnthropicSdk, ensureBedrockSdk } from './claude/message-utils.js';
import { resolveModelFromSettings } from '../utils/model-utils.js';
import { getClaudeDir } from '../utils/path-utils.js';

const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONVERSATION_TEXT = 1000;
const MAX_SANITIZED_LENGTH = 200;

const SESSION_TITLE_PROMPT = `Generate a concise title (3-7 words) for this coding session. The title must be in the SAME LANGUAGE as the user's message.

Return JSON: {"title": "..."}

English examples:
{"title": "Fix login button on mobile"}
{"title": "Refactor API error handling"}

Chinese examples:
{"title": "修复登录按钮移动端问题"}
{"title": "重构API错误处理逻辑"}

Bad: {"title": "Code changes"} (too vague)
Bad: {"title": "修复登录按钮在移动设备上不响应的问题"} (too long)`;

// --- Logging ---
// Title generation runs fire-and-forget after the daemon request completes,
// so activeRequestId is null. Output structured JSON via process.stdout.write
// which the daemon passes through for lines starting with '{'.
// DaemonBridge.java handles "title_log" events with appropriate log levels.

function logTitleEvent(level, message) {
  const line = JSON.stringify({
    type: 'daemon',
    event: 'title_log',
    level,
    message
  }) + '\n';
  process.stdout.write(line);
}

// --- Path utilities (matching CLI's sanitizePath logic) ---

function djb2Hash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function sanitizePath(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  const hash = Math.abs(djb2Hash(name)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}

function getSessionFilePath(sessionId, cwd) {
  const projectsDir = join(getClaudeDir(), 'projects');
  const sanitizedCwd = sanitizePath(cwd || process.cwd());
  return join(projectsDir, sanitizedCwd, `${sessionId}.jsonl`);
}

// --- API ---

/**
 * Resolve the Haiku model ID from settings.json, matching CLI behavior.
 * Uses resolveModelFromSettings which reads settings.env directly,
 * checking ANTHROPIC_SMALL_FAST_MODEL > ANTHROPIC_DEFAULT_HAIKU_MODEL > default.
 * @returns {string} Model ID
 */
function resolveHaikuModel() {
  const settings = loadClaudeSettings();
  return resolveModelFromSettings(DEFAULT_HAIKU_MODEL, settings?.env) || DEFAULT_HAIKU_MODEL;
}

/**
 * Create an Anthropic client based on the auth configuration.
 * @param {object} config - API config from setupApiKey()
 * @returns {Promise<object>} Anthropic client instance
 */
async function createAnthropicClient(config) {
  const cliHeaders = {
    'x-app': 'cli',
    'User-Agent': getCliUserAgent()
  };

  if (config.authType === 'aws_bedrock') {
    const bedrockModule = await ensureBedrockSdk();
    const AnthropicBedrock = bedrockModule.AnthropicBedrock || bedrockModule.default || bedrockModule;
    return new AnthropicBedrock({ defaultHeaders: cliHeaders });
  }

  const anthropicModule = await ensureAnthropicSdk();
  const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

  if (config.authType === 'auth_token') {
    return new Anthropic({
      authToken: config.apiKey,
      apiKey: null,
      baseURL: config.baseUrl || undefined,
      defaultHeaders: cliHeaders
    });
  }

  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
    defaultHeaders: cliHeaders
  });
}

/**
 * Call Haiku API to generate a title.
 * @param {string} userMessage - The user's first message text
 * @returns {Promise<string|null>} Generated title or null
 */
async function callHaikuApi(userMessage) {
  const config = setupApiKey();

  // CLI login uses SDK-native OAuth which the direct Anthropic SDK doesn't support.
  if (config.authType === 'cli_login') {
    logTitleEvent('info', 'Skipping title generation: CLI login mode not supported for direct API calls');
    return null;
  }

  if (!config.apiKey && config.authType !== 'api_key_helper') {
    logTitleEvent('info', 'Skipping title generation: no API key available (authType: ' + config.authType + ')');
    return null;
  }

  const client = await createAnthropicClient(config);
  const model = resolveHaikuModel();
  logTitleEvent('info', 'Calling Haiku API, model: ' + model);

  const response = await client.messages.create({
    model,
    max_tokens: 128,
    messages: [{ role: 'user', content: userMessage }],
    system: SESSION_TITLE_PROMPT,
  });

  const text = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) {
    logTitleEvent('warn', 'Haiku API returned empty response');
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed.title && typeof parsed.title === 'string') {
      return parsed.title.trim() || null;
    }
    logTitleEvent('warn', 'Haiku API response missing "title" field: ' + text.substring(0, 200));
    return null;
  } catch {
    const jsonMatch = text.match(/\{[^}]*"title"\s*:\s*"[^"]*"[^}]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.title && typeof parsed.title === 'string') {
          return parsed.title.trim() || null;
        }
      } catch {
        // fall through
      }
    }
    logTitleEvent('warn', 'Failed to parse Haiku API response as JSON: ' + text.substring(0, 200));
    return null;
  }
}

/**
 * Save AI title to the JSONL session file.
 * @param {string} sessionId
 * @param {string} title
 * @param {string|null} cwd
 */
async function saveAiTitle(sessionId, title, cwd) {
  try {
    const sessionFile = getSessionFilePath(sessionId, cwd);
    const dir = join(sessionFile, '..');

    await mkdir(dir, { recursive: true });

    const entry = {
      type: 'ai-title',
      aiTitle: title,
      sessionId
    };

    await appendFile(sessionFile, JSON.stringify(entry) + '\n', 'utf8');
    logTitleEvent('info', 'Saved AI title: "' + title + '" for session ' + sessionId);
  } catch (e) {
    logTitleEvent('error', 'Failed to save AI title: ' + e.message);
  }
}

/**
 * Generate and save an AI title for the session.
 * Called when a session turn ends successfully.
 * Fire-and-forget: errors are logged to IDEA via structured daemon events.
 *
 * @param {string} userMessage - The user's first message text (already extracted)
 * @param {string} sessionId - Session ID
 * @param {string|null} cwd - Working directory
 */
export async function generateSessionTitle(userMessage, sessionId, cwd) {
  if (!userMessage || !userMessage.trim() || !sessionId) {
    logTitleEvent('info', 'Skipping title generation: missing userMessage or sessionId');
    return;
  }

  try {
    const input = userMessage.length > MAX_CONVERSATION_TEXT
      ? userMessage.slice(-MAX_CONVERSATION_TEXT)
      : userMessage;

    const title = await callHaikuApi(input);
    if (title) {
      await saveAiTitle(sessionId, title, cwd);
    } else {
      logTitleEvent('info', 'Title generation returned no result for session ' + sessionId);
    }
  } catch (e) {
    logTitleEvent('error', 'Title generation failed: ' + e.message);
  }
}
