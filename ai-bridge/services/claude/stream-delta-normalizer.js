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

function getModeMap(turnState) {
  if (!(turnState.blockStreamModeByKey instanceof Map)) {
    turnState.blockStreamModeByKey = new Map();
  }
  return turnState.blockStreamModeByKey;
}

function modeKey(kind, blockIndex) {
  return `${kind}:${blockIndex}`;
}

function computeNovelDelta(previous, incoming, mode) {
  if (!incoming) {
    return { novel: '', next: previous, mode };
  }
  if (!previous) {
    return { novel: incoming, next: incoming, mode };
  }

  // Cumulative-snapshot path: incoming is previous + new content. Confirms the
  // block is in snapshot mode for any subsequent corrective rewrites.
  if (incoming.startsWith(previous)) {
    return { novel: incoming.slice(previous.length), next: incoming, mode: 'snapshot' };
  }

  // Stale replay: incoming is fully contained at the start or end of previous.
  if (previous.startsWith(incoming) || previous.endsWith(incoming)) {
    return { novel: '', next: previous, mode };
  }

  // Fall-through: incoming neither extends nor is a stale replay of previous.
  //
  // For Anthropic-standard providers this is the regular incremental path —
  // each delta is just the next chunk and previous is the cumulative content.
  //
  // For Claude-compatible providers in cumulative-snapshot mode (mimo-v2.5-pro,
  // GLM, MiniMax, etc.) this branch fires when the model emits a "rewritten"
  // snapshot mid-stream: a typo correction, a token re-translation, or a
  // paraphrase.  The two strings share a long common prefix but diverge in the
  // middle, so neither startsWith nor endsWith matches.  Naively appending the
  // rewritten snapshot would visibly double every character before the
  // divergence point — the bug captured in image 1 of issue tracker
  // streaming-duplication-fix-2026-04-28.md.
  //
  // Mode tracking distinguishes the two: once a block has produced at least one
  // confirmed snapshot delta, we know the provider speaks cumulative-snapshot
  // for that block, and any later divergent payload must be a correction, not
  // an incremental fragment.  Absorb it silently and update bookkeeping so the
  // next genuine extension can still be diffed correctly.
  if (mode === 'snapshot') {
    return { novel: '', next: incoming, mode };
  }

  // Default: Anthropic-standard incremental delta.
  return { novel: incoming, next: previous + incoming, mode: 'incremental' };
}

export function normalizeStreamDelta(turnState, kind, index, incoming) {
  const text = typeof incoming === 'string' ? incoming : '';
  const key = kind === 'thinking' ? 'thinkingBlockContentByIndex' : 'textBlockContentByIndex';
  const blockMap = getBlockMap(turnState, key);
  const blockIndex = getBlockIndex(index);
  const previous = blockMap.get(blockIndex) || '';

  const modeMap = getModeMap(turnState);
  const mKey = modeKey(kind, blockIndex);
  const mode = modeMap.get(mKey);

  const result = computeNovelDelta(previous, text, mode);
  blockMap.set(blockIndex, result.next);
  if (result.mode && result.mode !== mode) {
    modeMap.set(mKey, result.mode);
  }
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
  // Lock snapshot mode if the assistant snapshot extends the prior accumulated
  // content (a confirmed cumulative-snapshot signal).  Without this, blocks
  // whose deltas were all single-shot fragments would keep their default
  // incremental mode and a later corrective rewrite would still duplicate.
  if (text.length > 0 && previous.length > 0 && text.startsWith(previous) && text !== previous) {
    const modeMap = getModeMap(turnState);
    modeMap.set(modeKey(kind, blockIndex), 'snapshot');
  }
}
