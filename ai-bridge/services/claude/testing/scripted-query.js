/**
 * Test doubles for the SDK query object used by persistent-runtime tests.
 *
 * The message iterator here is a NATIVE async generator over a single-slot
 * message queue — the same shape as the SDK's readSdkMessages() in sdk.mjs:
 *
 *   async *readSdkMessages() {
 *     try { for await (const e of this.inputStream) yield e; }
 *     finally { await this.cleanup(); }
 *   }
 *
 * The shape matters. Native async generators queue concurrent next() callers
 * and hand each queued caller a distinct value in FIFO order, so an abandoned
 * next() (e.g. from a timeout race) invisibly consumes the next produced
 * value. Plain-function mocks whose next() independently returns a fresh
 * value cannot express that failure mode — which is exactly how the
 * swallowed-first-event bug in the original drain approach slipped past its
 * tests (PR #1410 review).
 */

export class MessageQueue {
  queue = [];
  readResolve = null;
  isDone = false;

  next() {
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift() });
    }
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => { this.readResolve = resolve; });
  }

  enqueue(value) {
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = null;
      resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  end() {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = null;
      resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator]() { return this; }
}

/**
 * Fake SDK query that consumes the runtime's input stream and answers the
 * i-th user message with turnScripts[i] (an array of SDK messages, enqueued
 * in order). Events listed after a result message model post-result
 * stragglers. With an empty script list the query simply pends — the real
 * iterator's behavior between turns — until close() ends the stream.
 *
 * Also records next() concurrency: maxInflight > 1 means something other
 * than the perpetual reader consumed the iterator concurrently, which is the
 * exact condition that loses events on the real SDK.
 */
export function createScriptedQuery({ prompt, options }, turnScripts = []) {
  const channel = new MessageQueue();
  const inputs = [];
  const inputWaiters = [];
  let waitIndex = 0;

  (async () => {
    for await (const userMessage of prompt) {
      inputs.push(userMessage);
      const waiter = inputWaiters.shift();
      if (waiter) waiter(userMessage);
      const script = turnScripts[inputs.length - 1] || [];
      for (const event of script) {
        channel.enqueue(event);
      }
    }
  })().catch(() => { /* input stream errored on dispose — irrelevant to tests */ });

  // Same shape as the SDK's readSdkMessages(): a native async generator over
  // the internal message stream.
  async function* readMessages() {
    for await (const event of channel) yield event;
  }
  const generator = readMessages();

  const stats = { nextCalls: 0, inflight: 0, maxInflight: 0 };

  return {
    options,
    channel,
    inputs,
    stats,
    /** Resolves with the next not-yet-awaited user message (FIFO). */
    waitForInput() {
      if (waitIndex < inputs.length) {
        const message = inputs[waitIndex];
        waitIndex += 1;
        return Promise.resolve(message);
      }
      return new Promise((resolve) => {
        inputWaiters.push((message) => {
          waitIndex += 1;
          resolve(message);
        });
      });
    },
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    close() {
      channel.end();
    },
    next() {
      stats.nextCalls += 1;
      stats.inflight += 1;
      stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      return generator.next().finally(() => { stats.inflight -= 1; });
    },
  };
}

/** Common SDK message shapes. */
export function assistantText(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

export function streamTextDelta(text) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
}

export function messageStart() {
  return {
    type: 'stream_event',
    event: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  };
}

export const RESULT_OK = { type: 'result', is_error: false };

/**
 * Let the perpetual reader run: it pulls from the iterator across macrotask
 * boundaries (an I/O boundary in production), so inter-turn stragglers need a
 * few ticks to be consumed.
 */
export async function settleReader(ticks = 5) {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
