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

export function processMessageContent(msg, turnState) {
  if (msg.type !== 'assistant') return;
  const content = msg.message?.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        const currentText = block.text || '';
        // Send delta if content grew, regardless of hasStreamEvents
        // This ensures conservative sync works correctly and prevents content loss
        // (especially important for markdown tables which need complete row structures)
        if (turnState.streamingEnabled && currentText.length > turnState.lastAssistantContent.length) {
          const delta = currentText.substring(turnState.lastAssistantContent.length);
          if (delta) {
            process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastAssistantContent = currentText;
        } else if (!turnState.streamingEnabled) {
          console.log('[CONTENT]', truncateErrorContent(currentText));
        }
      } else if (block.type === 'thinking') {
        const thinkingText = block.thinking || block.text || '';
        // Send delta if thinking grew, regardless of hasStreamEvents
        if (turnState.streamingEnabled && thinkingText.length > turnState.lastThinkingContent.length) {
          const delta = thinkingText.substring(turnState.lastThinkingContent.length);
          if (delta) {
            process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastThinkingContent = thinkingText;
        } else if (!turnState.streamingEnabled) {
          console.log('[THINKING]', thinkingText);
        }
      }
    }
  } else if (typeof content === 'string') {
    // Send delta if content grew, regardless of hasStreamEvents
    if (turnState.streamingEnabled && content.length > turnState.lastAssistantContent.length) {
      const delta = content.substring(turnState.lastAssistantContent.length);
      if (delta) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
      }
      turnState.lastAssistantContent = content;
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
  // Always output non-assistant messages
  if (msg.type !== 'assistant') {
    return true;
  }

  // For assistant messages:
  // - In streaming mode: output if has tool_use OR always output for conservative sync
  //   (needed to prevent content loss - Java layer's handleAssistantMessage performs
  //   conservative sync which catches any missed deltas)
  // - In non-streaming mode: always output
  if (!turnState.streamingEnabled) {
    return true;
  }

  // Always output assistant messages for conservative sync (prevents delta loss)
  // The Java layer uses the full assistant JSON to fill any gaps in streaming content
  return true;
}
