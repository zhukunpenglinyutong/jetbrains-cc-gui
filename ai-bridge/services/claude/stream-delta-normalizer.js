function getBlockMap(turnState, key) {
  if (!(turnState[key] instanceof Map)) {
    turnState[key] = new Map();
  }
  return turnState[key];
}

function getBlockIndex(index) {
  const numericIndex = typeof index === 'string' ? Number(index) : index;
  return Number.isInteger(numericIndex) && numericIndex >= 0 ? numericIndex : 0;
}

function computeNovelDelta(previous, incoming) {
  if (!incoming) {
    return { novel: '', next: previous };
  }
  if (!previous) {
    return { novel: incoming, next: incoming };
  }

  // Some Claude-compatible providers send each stream delta as the full block
  // snapshot so far.  Treat prefix growth as a snapshot and forward only the
  // suffix that the frontend has not seen yet.
  if (incoming.startsWith(previous)) {
    return { novel: incoming.slice(previous.length), next: incoming };
  }

  // Exact stale replays are not useful and cause visible duplication.
  if (previous.endsWith(incoming)) {
    return { novel: '', next: previous };
  }

  return { novel: incoming, next: previous + incoming };
}

export function normalizeStreamDelta(turnState, kind, index, incoming) {
  const text = typeof incoming === 'string' ? incoming : '';
  const key = kind === 'thinking' ? 'thinkingBlockContentByIndex' : 'textBlockContentByIndex';
  const blockMap = getBlockMap(turnState, key);
  const blockIndex = getBlockIndex(index);
  const previous = blockMap.get(blockIndex) || '';
  const result = computeNovelDelta(previous, text);
  blockMap.set(blockIndex, result.next);
  return result.novel;
}

export function rememberStreamSnapshot(turnState, kind, index, snapshot) {
  const text = typeof snapshot === 'string' ? snapshot : '';
  const key = kind === 'thinking' ? 'thinkingBlockContentByIndex' : 'textBlockContentByIndex';
  const blockMap = getBlockMap(turnState, key);
  const blockIndex = getBlockIndex(index);
  const previous = blockMap.get(blockIndex) || '';
  if (text.length >= previous.length) {
    blockMap.set(blockIndex, text);
  }
}
