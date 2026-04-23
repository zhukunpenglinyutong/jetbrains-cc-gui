import { emitAccumulatedUsage, mergeUsage } from '../../utils/usage-utils.js';
import { truncateErrorContent, truncateToolResultBlock } from './message-output-filter.js';

export function emitUsageTag(msg) {
  if (msg.type === 'assistant' && msg.message?.usage) {
    const {
      input_tokens = 0,
      output_tokens = 0,
      cache_creation_input_tokens = 0,
      cache_read_input_tokens = 0
    } = msg.message.usage;
    console.log('[USAGE]', JSON.stringify({
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens
    }));
  }
}

export function createTurnState(requestContext, runtime) {
  return {
    streamingEnabled: requestContext.streamingEnabled,
    streamStarted: false,
    streamEnded: false,
    hasStreamEvents: false,
    lastAssistantContent: '',
    lastThinkingContent: '',
    finalSessionId: requestContext.requestedSessionId || runtime?.sessionId || '',
    accumulatedUsage: null
  };
}

export function processStreamEvent(msg, turnState) {
  const event = msg.event;
  if (!event) return;

  if (event.type === 'message_start' && event.message?.usage) {
    turnState.accumulatedUsage = mergeUsage(turnState.accumulatedUsage, event.message.usage);
  }

  if (event.type === 'message_delta' && event.usage) {
    turnState.accumulatedUsage = mergeUsage(turnState.accumulatedUsage, event.usage);
    emitAccumulatedUsage(turnState.accumulatedUsage);
  }

  if (event.type === 'content_block_delta' && event.delta) {
    if (event.delta.type === 'text_delta' && event.delta.text) {
      process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(event.delta.text)}\n`);
      turnState.lastAssistantContent += event.delta.text;
    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(event.delta.thinking)}\n`);
      turnState.lastThinkingContent += event.delta.thinking;
    }
  }
}

// FIX (defensive): Flag suspiciously large first-emission deltas in a
// streaming-enabled turn where no stream_event has arrived yet. In normal
// streaming this shouldn't happen — content_block_delta events should
// populate lastAssistantContent incrementally. A large initial jump from ''
// suggests the iterator leaked a full-text `assistant` message from a
// previous turn. Only logs; does not alter behavior.
const SUSPICIOUS_INITIAL_DELTA_CHARS = 2000;

function warnOnSuspiciousInitialDelta(turnState, delta, kind) {
  if (
    turnState.streamingEnabled &&
    !turnState.hasStreamEvents &&
    delta.length > SUSPICIOUS_INITIAL_DELTA_CHARS &&
    turnState.lastAssistantContent.length === 0 &&
    turnState.lastThinkingContent.length === 0
  ) {
    console.warn('[DEFENSIVE] Large initial ' + kind + ' delta without prior stream events ('
      + delta.length + ' chars). Possible stale content leak from previous turn. Preview='
      + JSON.stringify(delta.slice(0, 120)));
  }
}

export function processMessageContent(msg, turnState) {
  if (msg.type !== 'assistant') return;
  const content = msg.message?.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        const currentText = block.text || '';
        if (turnState.streamingEnabled && !turnState.hasStreamEvents && currentText.length > turnState.lastAssistantContent.length) {
          const delta = currentText.substring(turnState.lastAssistantContent.length);
          if (delta) {
            warnOnSuspiciousInitialDelta(turnState, delta, 'text');
            process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastAssistantContent = currentText;
        } else if (turnState.streamingEnabled && turnState.hasStreamEvents) {
          if (currentText.length > turnState.lastAssistantContent.length) {
            turnState.lastAssistantContent = currentText;
          }
        } else if (!turnState.streamingEnabled) {
          console.log('[CONTENT]', truncateErrorContent(currentText));
        }
      } else if (block.type === 'thinking') {
        const thinkingText = block.thinking || block.text || '';
        if (turnState.streamingEnabled && !turnState.hasStreamEvents && thinkingText.length > turnState.lastThinkingContent.length) {
          const delta = thinkingText.substring(turnState.lastThinkingContent.length);
          if (delta) {
            warnOnSuspiciousInitialDelta(turnState, delta, 'thinking');
            process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastThinkingContent = thinkingText;
        } else if (turnState.streamingEnabled && turnState.hasStreamEvents) {
          if (thinkingText.length > turnState.lastThinkingContent.length) {
            turnState.lastThinkingContent = thinkingText;
          }
        } else if (!turnState.streamingEnabled) {
          console.log('[THINKING]', thinkingText);
        }
      }
    }
  } else if (typeof content === 'string') {
    if (turnState.streamingEnabled && !turnState.hasStreamEvents && content.length > turnState.lastAssistantContent.length) {
      const delta = content.substring(turnState.lastAssistantContent.length);
      if (delta) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
      }
      turnState.lastAssistantContent = content;
    } else if (turnState.streamingEnabled && turnState.hasStreamEvents) {
      if (content.length > turnState.lastAssistantContent.length) {
        turnState.lastAssistantContent = content;
      }
    } else if (!turnState.streamingEnabled) {
      console.log('[CONTENT]', truncateErrorContent(content));
    }
  }
}

export function processToolResultMessages(msg) {
  if (msg.type !== 'user') return;
  const content = msg.message?.content ?? msg.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_result') {
      console.log('[TOOL_RESULT]', JSON.stringify(truncateToolResultBlock(block)));
    }
  }
}

export function shouldOutputMessage(msg, turnState) {
  if (!(turnState.streamingEnabled && msg.type === 'assistant')) {
    return true;
  }
  const msgContent = msg.message?.content;
  const hasToolUse = Array.isArray(msgContent) && msgContent.some(block => block.type === 'tool_use');
  return !!hasToolUse;
}
