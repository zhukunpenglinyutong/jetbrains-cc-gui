import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';

const VALIDATION_BLOCK_BYTES = 4096;
const checksum = (bytes) => createHash('sha256').update(bytes).digest();

export function createSessionReader() {
  let pending = null;
  let rescanRequested = false;
  let decoder = new StringDecoder('utf8');
  let remainder = '';
  let tail = Buffer.alloc(0);
  let blockHashes = [];
  let partialBlock = Buffer.alloc(0);
  let nextValidationBlock = 1;
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
        blockHashes = [];
        partialBlock = Buffer.alloc(0);
        nextValidationBlock = 1;
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
      // Metadata can collide. Check head/tail plus one rotating interior block, at most 12 KiB per scan.
      // A stable file's unsampled rewrite is found within one full rotation, without rereading it every update.
      if (!replaced && metadata.size >= reader.offset && tail.length > 0) {
        const headLength = Math.min(VALIDATION_BLOCK_BYTES, reader.offset);
        const samples = [{ position: 0, length: headLength, hash: blockHashes[0] ?? checksum(partialBlock) }];
        if (reader.offset > headLength) {
          samples.push({ position: reader.offset - tail.length, length: tail.length, hash: checksum(tail) });
        }
        const endBlock = blockHashes.length - (partialBlock.length === 0 ? 1 : 0);
        if (endBlock > 1) {
          if (nextValidationBlock >= endBlock) nextValidationBlock = 1;
          samples.push({ position: nextValidationBlock * VALIDATION_BLOCK_BYTES,
            length: VALIDATION_BLOCK_BYTES, hash: blockHashes[nextValidationBlock] });
          nextValidationBlock = nextValidationBlock + 1 >= endBlock ? 1 : nextValidationBlock + 1;
        }
        for (const sample of samples) {
          const overlap = Buffer.allocUnsafe(sample.length);
          let checkedBytes = 0;
          while (checkedBytes < overlap.length) {
            const { bytesRead } = await handle.read(overlap, checkedBytes, overlap.length - checkedBytes, sample.position + checkedBytes);
            if (!bytesRead) break;
            checkedBytes += bytesRead;
          }
          if (checkedBytes !== overlap.length || !checksum(overlap).equals(sample.hash)) {
            replaced = true;
            break;
          }
        }
      }
      if (replaced) {
        reader.lines = [];
        reader.offset = 0;
        remainder = '';
        tail = Buffer.alloc(0);
        blockHashes = [];
        partialBlock = Buffer.alloc(0);
        nextValidationBlock = 1;
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
          const bytes = buffer.subarray(0, bytesRead);
          tail = bytesRead >= VALIDATION_BLOCK_BYTES
            ? Buffer.from(bytes.subarray(bytesRead - VALIDATION_BLOCK_BYTES))
            : Buffer.from(Buffer.concat([tail, bytes]).subarray(-VALIDATION_BLOCK_BYTES));
          // Build the validation baseline from bytes already read for parsing, including split UTF-8/JSONL records.
          const combined = Buffer.concat([partialBlock, bytes]);
          let consumed = 0;
          for (; consumed + VALIDATION_BLOCK_BYTES <= combined.length; consumed += VALIDATION_BLOCK_BYTES) {
            blockHashes.push(checksum(combined.subarray(consumed, consumed + VALIDATION_BLOCK_BYTES)));
          }
          partialBlock = Buffer.from(combined.subarray(consumed));
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
