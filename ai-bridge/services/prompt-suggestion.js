/**
 * Prompt Suggestion Service.
 * Predicts what the user might type next based on recent conversation context.
 * Uses a low-cost API call (Haiku / low effort) to generate short suggestions.
 *
 * Input (stdin JSON):
 * - recentMessages: Array of { role: 'user'|'assistant', content: string }
 * - model: Optional model ID override
 *
 * Output (stdout):
 * - [PROMPT_SUGGESTION]<text> on success
 * - [PROMPT_SUGGESTION] (empty) when suggestion is filtered out
 * - [PROMPT_SUGGESTION_ERROR]<message> on failure
 */

import { loadClaudeSdk, isClaudeSdkAvailable } from '../utils/sdk-loader.js';
import { setupApiKey } from '../config/api-config.js';
import { getRealHomeDir } from '../utils/path-utils.js';

let claudeSdk = null;

async function ensureClaudeSdk() {
  if (!claudeSdk) {
    if (!isClaudeSdkAvailable()) {
      const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      throw error;
    }
    claudeSdk = await loadClaudeSdk();
  }
  return claudeSdk;
}

// The suggestion generation prompt — adapted from Claude CLI's prompt
const SUGGESTION_PROMPT = `You predict what the user would type next. Output ONLY the short phrase, nothing else.

Rules:
- 2-12 words (or 2-30 CJK characters)
- Single line, no newlines
- No explanation, no reasoning, no quotes
- Match the user's language (Chinese/English/etc.)
- No evaluative phrases (thanks, looks good, 谢谢, 很好)
- No AI-voice (Let me, I'll, 让我, 我来)
- Empty response if unsure

Examples:
"fix bug and run tests" + bug fixed → run the tests
代码写完 → 提交代码
Task done → commit this
Asked to continue → yes`;

// Action words that are acceptable as single-word suggestions
const SINGLE_WORD_ACTIONS = new Set([
  'yes', 'yeah', 'yep', 'yea', 'yup', 'sure', 'ok', 'okay',
  'push', 'commit', 'deploy', 'stop', 'continue', 'check', 'no',
]);

/**
 * Check if a suggestion should be filtered out.
 * Returns a reason string if invalid, or null if valid.
 * @param {string} text - The suggestion text
 * @returns {string|null} Filter reason or null
 */
function getFilterReason(text) {
  if (!text) return 'empty';

  const lower = text.toLowerCase();
  const trimmed = text.trim();
  // CJK characters count as individual "words" for length checks
  const cjkChars = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const hasCJK = cjkChars > 0;
  const wordCount = hasCJK
    ? cjkChars + trimmed.split(/\s+/).filter(w => !/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(w)).length
    : trimmed.split(/\s+/).length;

  // Exact match filters
  if (lower === 'done') return 'done';
  if (lower === 'nothing found' || lower === 'nothing found.' ||
      lower.startsWith('nothing to suggest') || lower.startsWith('no suggestion')) {
    return 'meta_text';
  }

  // Error messages
  if (lower.startsWith('api error:') || lower.startsWith('prompt is too long') ||
      lower.startsWith('request timed out') || lower.startsWith('invalid api key') ||
      lower.startsWith('image was too large')) {
    return 'error_message';
  }

  // Prefixed labels (e.g., "Note: ...", "Warning: ...")
  if (/^\w+:\s/.test(text)) return 'prefixed_label';

  // Too few words (unless it's an action word)
  if (wordCount < 2) {
    if (text.startsWith('/')) return null; // Slash commands are fine
    if (!SINGLE_WORD_ACTIONS.has(lower)) return 'too_few_words';
  }

  // Too many words or too long (CJK chars are denser, allow more "words")
  const maxWords = hasCJK ? 30 : 12;
  if (wordCount > maxWords) return 'too_many_words';
  if (text.length >= 100) return 'too_long';

  // Multiple sentences (including CJK punctuation)
  if (/[.!?]\s+[A-Z]/.test(text)) return 'multiple_sentences';
  if (/[。！？][^"'）》」】)]*[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return 'multiple_sentences';

  // Has formatting (newlines, markdown bold)
  if (/\n|\*\*/.test(text)) return 'has_formatting';

  // Evaluative language (English and CJK)
  if (/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/i.test(lower)) {
    return 'evaluative';
  }
  if (/^(谢谢|感谢|不错|很好|太好了|完美|好的|没问题|可以了|就这样|辛苦了)/.test(text)) {
    return 'evaluative';
  }

  // Claude-voice patterns (English and CJK)
  if (/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(text)) {
    return 'claude_voice';
  }
  if (/^(让我|我来|我会|我可以|我认为|我注意到|我觉得|我建议|这是|这个|这将|你可以|你应该|当然|好的，)/.test(text)) {
    return 'claude_voice';
  }

  return null;
}

/**
 * Format recent messages into a conversation context string.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
function formatConversationContext(messages) {
  if (!messages || messages.length === 0) {
    return '';
  }

  return messages
    .map(msg => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      // Truncate long messages to save tokens
      const content = msg.content.length > 500
        ? msg.content.slice(0, 500) + '...'
        : msg.content;
      return `${role}: ${content}`;
    })
    .join('\n\n');
}

/**
 * Read input from stdin.
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Generate a prompt suggestion based on recent conversation.
 * @param {Array<{role: string, content: string}>} recentMessages
 * @param {string|null} model - Optional model override
 * @returns {Promise<string|null>} Suggestion text or null
 */
async function generateSuggestion(recentMessages, model) {
  const sdk = await ensureClaudeSdk();
  const { query } = sdk;

  // Set up API key
  process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';
  setupApiKey();

  const workingDirectory = getRealHomeDir();

  // Build the full prompt with conversation context
  const conversationContext = formatConversationContext(recentMessages);
  const fullPrompt = conversationContext
    ? `Here is the recent conversation:\n\n${conversationContext}\n\nWhat would the user type next?`
    : 'What would the user type next?';

  const options = {
    cwd: workingDirectory,
    permissionMode: 'bypassPermissions',
    model: 'haiku',
    maxTurns: 1,
    systemPrompt: SUGGESTION_PROMPT,
    settingSources: ['user', 'project', 'local'],
  };

  console.log('[PromptSuggestion] Calling Claude SDK for suggestion...');

  const result = query({
    prompt: fullPrompt,
    options,
  });

  let responseText = '';
  for await (const msg of result) {
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            responseText += block.text;
          }
        }
      } else if (typeof content === 'string') {
        responseText += content;
      }
    }
  }

  const suggestion = responseText.trim();
  if (!suggestion) return null;

  const filterReason = getFilterReason(suggestion);
  if (filterReason) {
    console.log(`[PromptSuggestion] Suggestion filtered: reason="${filterReason}", text="${suggestion}"`);
    return null;
  }

  return suggestion;
}

/**
 * Main entry point.
 */
async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const { recentMessages, model } = data;

    if (!recentMessages || recentMessages.length === 0) {
      console.log('[PROMPT_SUGGESTION]');
      process.exit(0);
    }

    console.log(`[PromptSuggestion] Generating suggestion from ${recentMessages.length} recent messages`);

    const suggestion = await generateSuggestion(recentMessages, model || null);

    if (suggestion) {
      // Encode newlines to prevent Java's readLine() from splitting
      const encoded = suggestion.replace(/\n/g, '{{NEWLINE}}');
      console.log(`[PROMPT_SUGGESTION]${encoded}`);
    } else {
      console.log('[PROMPT_SUGGESTION]');
    }

    process.exit(0);
  } catch (error) {
    console.error('[PromptSuggestion] Error:', error.message);
    console.log(`[PROMPT_SUGGESTION_ERROR]${error.message}`);
    process.exit(1);
  }
}

main();
