/**
 * AsyncStream - Manually controlled async iterator.
 * Used to pass user messages (including images) to the Claude Agent SDK.
 */
export class AsyncStream {
  constructor() {
    this.queue = [];
    this.readResolve = undefined;
    this.isDone = false;
    this.started = false;
  }

  [Symbol.asyncIterator]() {
    if (this.started) {
      throw new Error("Stream can only be iterated once");
    }
    this.started = true;
    return this;
  }

  async next() {
    if (this.queue.length > 0) {
      return { done: false, value: this.queue.shift() };
    }
    if (this.isDone) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => {
      this.readResolve = resolve;
    });
  }

  enqueue(value) {
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  done() {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  async return() {
    this.isDone = true;
    return { done: true, value: undefined };
  }
}
