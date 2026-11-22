export const STALL_TIMEOUT_ENV = 'CC_GUI_CLAUDE_STALL_TIMEOUT_MS';
export const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long a turn may receive nothing from the model before it is treated as a
 * stalled upstream (e.g. a relay that stops mid-stream). 0 disables the watchdog;
 * anything unparsable falls back to the default.
 */
export function resolveStallTimeoutMs(env = process.env) {
  const raw = env?.[STALL_TIMEOUT_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_STALL_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_STALL_TIMEOUT_MS;
  }
  return Math.floor(value);
}

/**
 * Keeps the set of main-conversation tool calls that have not returned yet.
 * While one is running (a long command, a subagent, an approval dialog) silence
 * from the model is expected, so it is not a stall.
 */
export function trackToolActivity(pendingToolUseIds, msg) {
  const blocks = msg?.message?.content;
  if (!Array.isArray(blocks)) return;
  if (msg.type === 'assistant') {
    for (const block of blocks) {
      if (block?.type === 'tool_use' && block.id) pendingToolUseIds.add(block.id);
    }
  } else if (msg.type === 'user') {
    for (const block of blocks) {
      if (block?.type === 'tool_result' && block.tool_use_id) pendingToolUseIds.delete(block.tool_use_id);
    }
  }
}

function createStallError(timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  const error = new Error(
    `Claude stopped responding: nothing was received from the model for ${seconds}s, so the upstream stream `
    + 'appears to have stalled. The request was cancelled; send the message again.'
  );
  error.code = 'CLAUDE_STREAM_STALLED';
  error.runtimeTerminated = true;
  return error;
}

/**
 * sink.take() that gives up when no message arrives for timeoutMs while no tool
 * call is in flight. On a stall the sink is failed with the same error so its
 * pending take() is released.
 */
export function takeWithStallTimeout(sink, { timeoutMs, hasToolInFlight }) {
  if (!(timeoutMs > 0)) {
    return sink.take();
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const arm = () => {
      timer = setTimeout(onTimer, timeoutMs);
    };
    const onTimer = () => {
      if (hasToolInFlight()) {
        arm();
        return;
      }
      const error = createStallError(timeoutMs);
      sink.fail(error);
      reject(error);
    };
    arm();
    sink.take().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
