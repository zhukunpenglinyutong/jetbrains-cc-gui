import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export function createSessionReader() {
  let pending = null;
  let rescanRequested = false;
  let decoder = new StringDecoder('utf8');
  let remainder = '';
  let tail = Buffer.alloc(0);
  let identity = null;
  let currentPath = null;
  let disposed = false;
  const reader = {
    lines: [],
    offset: 0,
    generation: 0,
    get hasPartialEntry() {
      return remainder.trim().length > 0;
    },
    read(path) {
      if (disposed) return Promise.reject(new Error('Session reader is disposed'));
      if (pending) {
        if (path === currentPath) {
          rescanRequested = true;
          return pending;
        }
        return pending.then(() => reader.read(path));
      }
      pending = refresh(path).finally(() => { pending = null; });
      return pending;
    },
    async dispose() {
      disposed = true;
      try { await pending; } finally {
        reader.lines = [];
        reader.offset = 0;
        remainder = '';
        tail = Buffer.alloc(0);
        decoder = new StringDecoder('utf8');
        identity = null;
        currentPath = null;
      }
    },
  };

  async function refresh(path) {
    do {
      rescanRequested = false;
      await scan(path);
    } while (rescanRequested);
    return reader;
  }

  async function scan(path) {
    const previousPath = currentPath;
    currentPath = path;
    const handle = await open(path, 'r');
    try {
      const metadata = await handle.stat();
      let replaced = !identity || previousPath !== path ||
        metadata.dev !== identity.dev || metadata.ino !== identity.ino ||
        metadata.birthtimeMs !== identity.birthtimeMs || metadata.size < reader.offset ||
        (metadata.size === reader.offset &&
          (metadata.mtimeMs !== identity.mtimeMs || metadata.ctimeMs !== identity.ctimeMs));
      // A file can be rewritten in place without changing its size or the
      // filesystem timestamps observed by Node on Windows. Compare the cached
      // tail for equal-size files as well as appended files so stale lines are
      // discarded before the next scan.
      if (!replaced && metadata.size >= reader.offset && tail.length > 0) {
        const overlap = Buffer.allocUnsafe(tail.length);
        let checkedBytes = 0;
        while (checkedBytes < overlap.length) {
          const { bytesRead } = await handle.read(overlap, checkedBytes, overlap.length - checkedBytes, reader.offset - tail.length + checkedBytes);
          if (!bytesRead) break;
          checkedBytes += bytesRead;
        }
        replaced = checkedBytes !== tail.length || !overlap.equals(tail);
      }
      if (replaced) {
        reader.lines = [];
        reader.offset = 0;
        remainder = '';
        tail = Buffer.alloc(0);
        decoder = new StringDecoder('utf8');
        reader.generation += 1;
      }
      identity = metadata;
      if (metadata.size > reader.offset) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, metadata.size - reader.offset));
        while (reader.offset < metadata.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - reader.offset), reader.offset);
          if (!bytesRead) break;
          reader.offset += bytesRead;
          tail = bytesRead >= 64
            ? Buffer.from(buffer.subarray(bytesRead - 64, bytesRead))
            : Buffer.concat([tail, buffer.subarray(0, bytesRead)]).subarray(-64);
          const entries = (remainder + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
          remainder = entries.pop();
          for (const entry of entries) {
            if (entry.trim()) reader.lines.push(entry);
          }
        }
      }
      return reader;
    } finally {
      await handle.close();
    }
  }

  return reader;
}
