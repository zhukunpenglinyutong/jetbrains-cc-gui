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
    textBlockContentByIndex: [],
    thinkingBlockContentByIndex: [],
    finalSessionId: requestContext.requestedSessionId || runtime?.sessionId || '',
    accumulatedUsage: null
  };
}

function normalizeBlockIndex(index) {
  return Number.isInteger(index) && index >= 0 ? index : 0;
}

function joinBlockContents(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(value => (typeof value === 'string' ? value : '')).join('');
}

function findSuffixPrefixOverlap(left, right, minOverlap = 1) {
  const a = typeof left === 'string' ? left : '';
  const b = typeof right === 'string' ? right : '';
  const maxOverlap = Math.min(a.length, b.length, 2000);
  for (let overlap = maxOverlap; overlap >= minOverlap; overlap -= 1) {
    if (a.slice(-overlap) === b.slice(0, overlap)) {
      return overlap;
    }
  }
  return 0;
}

function ensureBlockArrays(turnState) {
  if (!Array.isArray(turnState.textBlockContentByIndex)) {
    turnState.textBlockContentByIndex = [];
  }
  if (!Array.isArray(turnState.thinkingBlockContentByIndex)) {
    turnState.thinkingBlockContentByIndex = [];
  }
}

function updateAggregateContent(turnState, kind) {
  if (kind === 'thinking') {
    turnState.lastThinkingContent = joinBlockContents(turnState.thinkingBlockContentByIndex);
  } else {
    turnState.lastAssistantContent = joinBlockContents(turnState.textBlockContentByIndex);
  }
}

function getBlockContents(turnState, kind) {
  ensureBlockArrays(turnState);
  return kind === 'thinking'
    ? turnState.thinkingBlockContentByIndex
    : turnState.textBlockContentByIndex;
}

/**
 * Stream events from official SDKs are incremental deltas, but some compatible
 * providers send the full content accumulated for the current content block.
 * Track each block independently so cumulative providers only emit the novel
 * suffix while true incremental providers still append their delta unchanged.
 */
export function appendStreamDelta(turnState, kind, blockIndex, incomingText) {
  const incoming = typeof incomingText === 'string' ? incomingText : '';
  if (!incoming) return '';

  const blocks = getBlockContents(turnState, kind);
  const index = normalizeBlockIndex(blockIndex);
  const previous = typeof blocks[index] === 'string' ? blocks[index] : '';

  let delta;
  let nextValue;
  if (!previous) {
    delta = incoming;
    nextValue = incoming;
  } else if (incoming === previous) {
    delta = '';
    nextValue = previous;
  } else if (incoming.startsWith(previous)) {
    delta = incoming.slice(previous.length);
    nextValue = incoming;
  } else {
    const overlap = findSuffixPrefixOverlap(previous, incoming, 10);
    delta = overlap > 0 ? incoming.slice(overlap) : incoming;
    nextValue = previous + delta;
  }

  blocks[index] = nextValue;
  updateAggregateContent(turnState, kind);
  return delta;
}

/**
 * Full assistant snapshots are authoritative, but while real stream_event
 * deltas are active they must be treated as a conservative repair path only.
 * A snapshot that does not continue the tracked block is likely stale or from a
 * different block; emitting a global-length substring is what caused repeated
 * mid-message output in long responses.
 */
export function appendSnapshotDelta(turnState, kind, blockIndex, snapshotText) {
  const snapshot = typeof snapshotText === 'string' ? snapshotText : '';
  if (!snapshot) return '';

  const blocks = getBlockContents(turnState, kind);
  const index = normalizeBlockIndex(blockIndex);
  const previous = typeof blocks[index] === 'string' ? blocks[index] : '';

  let delta;
  let nextValue;
  if (!previous) {
    delta = snapshot;
    nextValue = snapshot;
  } else if (snapshot === previous) {
    delta = '';
    nextValue = previous;
  } else if (snapshot.startsWith(previous)) {
    delta = snapshot.slice(previous.length);
    nextValue = snapshot;
  } else if (turnState.hasStreamEvents) {
    delta = '';
    nextValue = previous;
  } else {
    const overlap = findSuffixPrefixOverlap(previous, snapshot);
    if (overlap > 0) {
      delta = snapshot.slice(overlap);
      nextValue = previous + delta;
    } else {
      delta = snapshot;
      nextValue = snapshot;
    }
  }

  blocks[index] = nextValue;
  updateAggregateContent(turnState, kind);
  return delta;
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
      const delta = appendStreamDelta(turnState, 'text', event.index, event.delta.text);
      if (delta) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
      }
    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      const delta = appendStreamDelta(turnState, 'thinking', event.index, event.delta.thinking);
      if (delta) {
        process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
      }
    }
  }
}

export function processMessageContent(msg, turnState) {
  if (msg.type !== 'assistant') return;
  const content = msg.message?.content;

  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (block.type === 'text') {
        const currentText = block.text || '';
        if (turnState.streamingEnabled) {
          const delta = appendSnapshotDelta(turnState, 'text', i, currentText);
          if (delta) {
            process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
          }
        } else if (!turnState.streamingEnabled) {
          console.log('[CONTENT]', truncateErrorContent(currentText));
        }
      } else if (block.type === 'thinking') {
        const thinkingText = block.thinking || block.text || '';
        if (turnState.streamingEnabled) {
          const delta = appendSnapshotDelta(turnState, 'thinking', i, thinkingText);
          if (delta) {
            process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
          }
        } else if (!turnState.streamingEnabled) {
          console.log('[THINKING]', thinkingText);
        }
      }
    }
  } else if (typeof content === 'string') {
    if (turnState.streamingEnabled) {
      const delta = appendSnapshotDelta(turnState, 'text', 0, content);
      if (delta) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
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
