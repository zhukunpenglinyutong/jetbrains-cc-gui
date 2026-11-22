import { readNativeHistoryPage } from './codex-native-history.js';

/** Read every native edit without hydrating a writer or returning other transcripts. */
export async function readCodexSessionEdits(read, { threadId, timeoutMs = 110_000 } = {}) {
  let expired = false;
  let timer;
  const timeoutError = new Error('Native session edits timed out');
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(timeoutError); }, timeoutMs);
  });
  const guardedRead = async (method, params) => {
    if (expired) throw timeoutError;
    const response = await read(method, params);
    if (expired) throw timeoutError;
    return response;
  };
  const collect = async () => {
    const pages = [];
    const seen = new Set();
    let cursor = null;
    let readMode = 'paged';
    let thread;
    do {
      const page = await readNativeHistoryPage(guardedRead, { threadId, cursor, readMode });
      thread ??= { id: page.thread.id, ...(page.thread.name ? { name: page.thread.name } : {}) };
      pages.push(page.messages.filter(message => message.type === 'assistant' && ['fileChange', 'file_change'].includes(message.raw?.codexItemType))
        .map(message => message.raw));
      readMode = page.readMode;
      cursor = page.cursor;
      if (cursor != null) {
        if (seen.has(cursor)) throw new Error('Native session edits repeated their history cursor');
        seen.add(cursor);
      } else if (!page.complete) {
        throw new Error('Native session edits received incomplete history without a cursor');
      }
    } while (cursor != null);
    // Pages arrive newest first; display edits chronologically and let newer snapshots win overlaps.
    const edits = new Map();
    for (const page of pages.reverse()) {
      for (const raw of page) edits.set(raw.uuid ?? Symbol(), raw);
    }
    return { thread, fileChangeMessages: [...edits.values()] };
  };
  try {
    return await Promise.race([collect(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
