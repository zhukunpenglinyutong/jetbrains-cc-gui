/**
 * Effective-chain selection for Claude session JSONL transcripts.
 *
 * The CLI never deletes rewound messages from the transcript. Rewinding
 * forks the conversation in place: subsequent messages get parentUuid
 * pointing past the rewound span, so the discarded branch stays on disk
 * as a dead chain. Reading the file line-by-line renders those dead
 * branches as if they were live conversation.
 *
 * Mirrors Claude Code's loadMessagesFromJsonlPath + buildConversationChain:
 * pick the newest non-sidechain leaf, walk parentUuid back to the root,
 * then recover parallel-tool siblings the single-parent walk orphans
 * (N parallel tool_uses stream as N assistant rows sharing one message.id;
 * the parentUuid chain keeps only one branch of that DAG).
 */

/**
 * Select the messages that form the effective conversation.
 * @param {Array<any>} entries parsed JSONL entries in file order
 * @param {Object} options chain selection options
 * @param {boolean} options.includePreCompactHistory keep the GUI-visible
 *   compact prefix; disable it when building model context
 * @returns {Array<any>} chain messages in conversation order; line order
 *   when the transcript carries no parentUuid fields at all (the plugin's
 *   direct-API fallback writer omits them, and chain-walking such a file
 *   would collapse every message into isolated leaves)
 */
export function selectConversationChain(entries, options = {}) {
  // Always return an array: callers chain .filter/.map onto the result, so a
  // truthy non-array input must not pass through.
  if (!Array.isArray(entries)) {
    return [];
  }
  if (entries.length === 0) {
    return entries;
  }

  const includePreCompactHistory = options.includePreCompactHistory !== false;
  const byUuid = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.uuid === 'string') {
      byUuid.set(entry.uuid, entry);
    }
  }
  if (byUuid.size === 0) {
    return entries;
  }

  // The CLI writes parentUuid on every row (null for the root). If no row
  // carries the field, this transcript was not written by the chain model
  // and line order is the only meaningful order.
  let hasParentField = false;
  for (const entry of byUuid.values()) {
    if ('parentUuid' in entry) {
      hasParentField = true;
      break;
    }
  }
  if (!hasParentField) {
    return entries;
  }

  // A row can lack the parentUuid KEY entirely: SDK-written roots, and rows
  // the plugin's direct-API fallback appends to a CLI-written file. An
  // explicit null stays a root (session start, compact boundary); a missing
  // key inherits the previous uuid-carrying row as its parent so a hybrid
  // transcript keeps its line-order continuity instead of collapsing the
  // walk at the first such row.
  //
  // prevUuid tracks MAINLINE rows only. A sidechain (subagent) row's parent
  // chain runs into the sidechain branch, so letting it become the implicit
  // parent would hang the next keyless mainline row off that branch.
  let prevUuid = null;
  for (const entry of byUuid.values()) {
    if (entry.isSidechain) {
      continue;
    }
    if (!('parentUuid' in entry) && prevUuid !== null) {
      byUuid.set(entry.uuid, { ...entry, parentUuid: prevUuid });
    }
    prevUuid = entry.uuid;
  }

  const leaf = selectNewestLeaf(byUuid);
  if (!leaf) {
    return entries;
  }

  const chain = walkParentChain(byUuid, leaf);
  if (chain.length === 0) {
    return entries;
  }
  const chainWithCompactHistory = includePreCompactHistory
    ? recoverCompactHistory(byUuid, chain)
    : recoverCompactModelHistory(byUuid, chain);
  const chainWithAttachments = recoverOrphanedTerminalAttachments(
    byUuid,
    chainWithCompactHistory
  );
  return recoverOrphanedParallelToolResults(byUuid, chainWithAttachments);
}

/**
 * A leaf is the nearest real user/assistant ancestor of any childless message
 * (attachments and local command metadata can trail a conversation message
 * without continuing the chain). The newest non-sidechain leaf is the tip of
 * the live branch; leaves of rewound branches are older by timestamp.
 *
 * Sidechain rows are excluded before computing leaves so their main-thread
 * parents remain candidates even when a subagent call is the newest row.
 */
function selectNewestLeaf(byUuid) {
  // A sidechain child hides its main-thread parent from the full graph's
  // leaf set. Exclude sidechains before finding leaves so a dead main branch
  // cannot win merely because the live branch ends in a sidechain row.
  const mainThread = new Map();
  for (const entry of byUuid.values()) {
    if (!entry.isSidechain) {
      mainThread.set(entry.uuid, entry);
    }
  }
  return newestNonSidechainLeaf(byUuid, mainThread) ?? newestNonSidechainLeaf(byUuid, byUuid);
}

function newestNonSidechainLeaf(byUuid, graph) {
  const parentUuids = new Set();
  for (const entry of graph.values()) {
    if (entry.parentUuid) {
      parentUuids.add(entry.parentUuid);
    }
  }

  const leafUuids = new Set();
  for (const entry of graph.values()) {
    if (parentUuids.has(entry.uuid)) {
      continue;
    }
    let current = entry;
    const seen = new Set();
    while (current) {
      if (seen.has(current.uuid)) {
        break;
      }
      seen.add(current.uuid);
      if ((current.type === 'user' || current.type === 'assistant')
          && !isSyntheticUserMessage(current)) {
        leafUuids.add(current.uuid);
        break;
      }
      current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
    }
  }

  let tip = null;
  let tipTime = 0;
  for (const uuid of leafUuids) {
    const entry = byUuid.get(uuid);
    if (entry.isSidechain) {
      continue;
    }
    const time = Date.parse(entry.timestamp ?? '') || 0;
    if (time > tipTime) {
      tipTime = time;
      tip = entry;
    }
  }
  return tip;
}

/**
 * Local command caveats and stdout are CLI metadata, not conversation turns.
 * They may be written after compacting while still pointing to the pre-compact
 * branch, so they must not hide a newer compact summary leaf.
 */
function isSyntheticUserMessage(entry) {
  if (entry.type !== 'user' || typeof entry.message?.content !== 'string') {
    return false;
  }
  const content = entry.message.content;
  return content.includes('<local-command-caveat>')
      || content.includes('<local-command-stdout>')
      || content.includes('<command-name>');
}

function walkParentChain(byUuid, tip) {
  const chain = [];
  const seen = new Set();
  let current = tip;
  while (current) {
    if (seen.has(current.uuid)) {
      break;
    }
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
  }
  chain.reverse();
  return chain;
}

function walkPreservedSegment(byUuid, segment) {
  const uuids = [];
  const seen = new Set();
  let current = byUuid.get(segment.tailUuid);
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    uuids.push(current.uuid);
    if (current.uuid === segment.headUuid) {
      uuids.reverse();
      return uuids;
    }
    current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
  }
  return null;
}

/**
 * Keep the compact summary and preserved tail for model context without
 * replaying the pre-compact prefix that Claude Code already summarized.
 */
function recoverCompactModelHistory(byUuid, chain) {
  const compact = findRelevantCompactBoundary(byUuid, chain);
  if (!compact) {
    return chain;
  }

  const { boundary, preservedUuids } = compact;
  const summary = findCompactSummary(byUuid, boundary);
  const preservedEntries = preservedUuids
    .map((uuid) => byUuid.get(uuid))
    .filter(Boolean);
  const boundaryIndex = chain.findIndex((entry) => entry.uuid === boundary.uuid);

  if (boundaryIndex >= 0) {
    const summaryIndex = summary.length > 0
      ? chain.findIndex((entry) => entry.uuid === summary[0].uuid)
      : -1;
    const insertAfter = summaryIndex >= boundaryIndex ? summaryIndex : boundaryIndex;
    const onChain = new Set(chain.map((entry) => entry.uuid));
    const inserts = [
      ...summary.filter((entry) => !onChain.has(entry.uuid)),
      ...preservedEntries.filter((entry) => !onChain.has(entry.uuid)),
    ];
    if (inserts.length === 0) {
      return chain;
    }
    return [
      ...chain.slice(0, insertAfter + 1),
      ...inserts,
      ...chain.slice(insertAfter + 1),
    ];
  }

  const continuationIndex = findCompactContinuationIndex(chain, boundary, preservedUuids);
  if (continuationIndex < 0) {
    return chain;
  }
  const block = [boundary, ...summary, ...preservedEntries];
  const compactUuids = new Set(block.map((entry) => entry.uuid));
  return [
    ...block,
    ...chain.slice(continuationIndex + 1).filter((entry) => !compactUuids.has(entry.uuid)),
  ];
}

/**
 * Keep the effective pre-compact conversation visible before the boundary.
 * Claude Code's loader prunes this prefix because it is only needed as model
 * context, but the GUI is a transcript viewer and must show the messages that
 * led to the compact summary. The preserved UUID carrier bridges the physical
 * gap between the last pre-compact assistant and the boundary; standard
 * Claude Code metadata can derive the same suffix from preservedSegment.
 */
function recoverCompactHistory(byUuid, chain) {
  const compact = findRelevantCompactBoundary(byUuid, chain);
  if (!compact) {
    return chain;
  }
  return recoverCompactHistoryForBoundary(byUuid, chain, compact.boundary, compact.preservedUuids);
}

/**
 * Recover one pinned boundary. Boundary selection must not re-run inside the
 * recursion: a pre-compact chain always contains the newest boundary's
 * preserved uuids, so re-selecting would keep picking that boundary and loop
 * forever on sessions compacted more than once. The nested boundary handed in
 * by buildPreCompactPrefix is strictly older, so the recursion terminates.
 */
function recoverCompactHistoryForBoundary(byUuid, chain, boundary, preservedUuids) {
  const boundaryInChain = chain.some((entry) => entry.uuid === boundary.uuid);
  const prefix = buildPreCompactPrefix(byUuid, boundary, preservedUuids);
  if (boundaryInChain) {
    const onChain = new Set(chain.map((entry) => entry.uuid));
    const uniquePrefix = prefix.filter((entry) => !onChain.has(entry.uuid));
    return uniquePrefix.length === 0 ? chain : [...uniquePrefix, ...chain];
  }

  const block = [
    ...prefix,
    boundary,
    ...findCompactSummary(byUuid, boundary),
  ];
  const compactUuids = new Set(block.map((entry) => entry.uuid));
  const continuationIndex = findCompactContinuationIndex(chain, boundary, preservedUuids);
  if (continuationIndex < 0) {
    return chain;
  }
  return [
    ...block,
    ...chain.slice(continuationIndex + 1).filter((entry) => !compactUuids.has(entry.uuid)),
  ];
}

function getCompactPreservedUuids(byUuid, boundary) {
  const preserved = boundary.compactMetadata?.preservedMessages;
  const segment = boundary.compactMetadata?.preservedSegment;
  let preservedUuids = Array.isArray(preserved?.allUuids)
    ? preserved.allUuids
    : preserved?.uuids;
  if (!Array.isArray(preservedUuids) && segment) {
    preservedUuids = walkPreservedSegment(byUuid, segment);
  }
  return Array.isArray(preservedUuids) ? preservedUuids : [];
}

function buildPreCompactPrefix(byUuid, boundary, preservedUuids) {
  const segment = boundary.compactMetadata?.preservedSegment;
  const headUuid = segment?.headUuid ?? preservedUuids.find((uuid) => byUuid.has(uuid));
  let preCompactChain = headUuid && byUuid.has(headUuid)
    ? walkParentChain(byUuid, byUuid.get(headUuid))
    : findPreCompactChain(byUuid, boundary.uuid);

  const nestedBoundary = preCompactChain.find((entry) => (
    entry.subtype === 'compact_boundary' && entry.uuid !== boundary.uuid
  ));
  if (nestedBoundary) {
    preCompactChain = recoverCompactHistoryForBoundary(
      byUuid,
      preCompactChain,
      nestedBoundary,
      getCompactPreservedUuids(byUuid, nestedBoundary)
    );
  }

  const onChain = new Set([boundary.uuid]);
  const prefix = [];
  for (const entry of preCompactChain) {
    if (!onChain.has(entry.uuid)) {
      prefix.push(entry);
      onChain.add(entry.uuid);
    }
  }
  for (const uuid of preservedUuids) {
    const entry = byUuid.get(uuid);
    if (entry && !onChain.has(uuid)) {
      prefix.push(entry);
      onChain.add(uuid);
    }
  }
  return prefix;
}

function findLatestCompactBoundary(byUuid) {
  let boundary = null;
  for (const entry of byUuid.values()) {
    if (entry.subtype === 'compact_boundary') {
      boundary = entry;
    }
  }
  return boundary;
}

function findRelevantCompactBoundary(byUuid, chain) {
  const chainBoundary = chain.find((entry) => entry.subtype === 'compact_boundary');
  const latestBoundary = findLatestCompactBoundary(byUuid);
  const latestPreservedUuids = latestBoundary
    ? getCompactPreservedUuids(byUuid, latestBoundary)
    : [];
  const boundary = latestBoundary && (
    !chainBoundary
    || chainBoundary.uuid === latestBoundary.uuid
    || hasCompactContinuation(chain, latestBoundary, latestPreservedUuids)
  )
    ? latestBoundary
    : chainBoundary;
  if (!boundary) {
    return null;
  }

  const preservedUuids = boundary.uuid === latestBoundary?.uuid
    ? latestPreservedUuids
    : getCompactPreservedUuids(byUuid, boundary);
  if (
    chain.some((entry) => entry.uuid === boundary.uuid)
    || hasCompactContinuation(chain, boundary, preservedUuids)
  ) {
    return { boundary, preservedUuids };
  }
  return null;
}

function findCompactSummary(byUuid, boundary) {
  const summaries = [];
  for (const entry of byUuid.values()) {
    if (entry.parentUuid === boundary.uuid && (entry.type === 'user' || entry.type === 'assistant')) {
      summaries.push(entry);
    }
  }
  const marked = summaries.find((entry) => entry.isCompactSummary);
  return marked ? [marked] : summaries.slice(0, 1);
}

function hasCompactContinuation(chain, boundary, preservedUuids) {
  const compactUuids = new Set([
    boundary.uuid,
    ...preservedUuids,
    boundary.compactMetadata?.preservedSegment?.headUuid,
    boundary.compactMetadata?.preservedSegment?.tailUuid,
  ]);
  return chain.some((entry) => compactUuids.has(entry.uuid));
}

function findCompactContinuationIndex(chain, boundary, preservedUuids) {
  const compactUuids = new Set([
    ...preservedUuids,
    boundary.compactMetadata?.preservedSegment?.headUuid,
    boundary.compactMetadata?.preservedSegment?.tailUuid,
  ]);
  let index = -1;
  for (let i = 0; i < chain.length; i++) {
    if (compactUuids.has(chain[i].uuid)) {
      index = i;
    }
  }
  return index;
}

function findPreCompactChain(byUuid, boundaryUuid) {
  const beforeBoundary = new Map();
  for (const [uuid, entry] of byUuid) {
    if (uuid === boundaryUuid) {
      break;
    }
    beforeBoundary.set(uuid, entry);
  }
  const leaf = selectNewestLeaf(beforeBoundary);
  return leaf ? walkParentChain(beforeBoundary, leaf) : [];
}

/**
 * Recover terminal attachment rows that parent directly to the selected
 * message. They are leaves in the JSONL graph, but their payload still
 * belongs to the live turn and must reach the session-history transformer.
 */
function recoverOrphanedTerminalAttachments(byUuid, chain) {
  const tip = chain[chain.length - 1];
  if (!tip) {
    return chain;
  }

  const onChain = new Set(chain.map((entry) => entry.uuid));
  const attachments = [];
  for (const entry of byUuid.values()) {
    if (
      entry.type === 'attachment' &&
      !entry.isSidechain &&
      !onChain.has(entry.uuid) &&
      entry.parentUuid === tip.uuid
    ) {
      attachments.push(entry);
    }
  }
  if (attachments.length === 0) {
    return chain;
  }

  byTimestamp(attachments);
  return [...chain, ...attachments];
}

/**
 * Post-pass for walkParentChain: recover sibling assistant rows and tool
 * results that the single-parent walk orphaned. Siblings share message.id
 * with an on-chain assistant; tool results attach to their source
 * assistant via parentUuid. Both are spliced right after the last
 * on-chain member of their sibling group so the group stays contiguous.
 */
function recoverOrphanedParallelToolResults(byUuid, chain) {
  const onChain = new Set(chain.map((entry) => entry.uuid));
  const chainAssistants = chain.filter(
    (entry) => entry.type === 'assistant' && entry.message && entry.message.id
  );
  if (chainAssistants.length === 0) {
    return chain;
  }

  const siblingsByMsgId = new Map();
  const toolResultsByAsst = new Map();
  for (const entry of byUuid.values()) {
    if (entry.type === 'assistant' && entry.message && entry.message.id) {
      const group = siblingsByMsgId.get(entry.message.id);
      if (group) {
        group.push(entry);
      } else {
        siblingsByMsgId.set(entry.message.id, [entry]);
      }
    } else if (
      entry.type === 'user' &&
      entry.parentUuid &&
      Array.isArray(entry.message && entry.message.content) &&
      entry.message.content.some((block) => block && block.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(entry.parentUuid);
      if (group) {
        group.push(entry);
      } else {
        toolResultsByAsst.set(entry.parentUuid, [entry]);
      }
    }
  }

  // Anchor = last on-chain member of each sibling group, so the group stays
  // contiguous and every recovered tool result lands after its tool_use.
  const anchorByMsgId = new Map();
  for (const assistant of chainAssistants) {
    anchorByMsgId.set(assistant.message.id, assistant);
  }

  const inserts = new Map();
  for (const assistant of chainAssistants) {
    const msgId = assistant.message.id;
    const anchor = anchorByMsgId.get(msgId);
    if (anchor !== assistant) {
      continue;
    }

    const group = siblingsByMsgId.get(msgId) ?? [assistant];
    const orphanedSiblings = group.filter((sibling) => !onChain.has(sibling.uuid));
    const orphanedToolResults = [];
    for (const member of group) {
      for (const toolResult of toolResultsByAsst.get(member.uuid) ?? []) {
        if (!onChain.has(toolResult.uuid)) {
          orphanedToolResults.push(toolResult);
        }
      }
    }
    if (orphanedSiblings.length === 0 && orphanedToolResults.length === 0) {
      continue;
    }

    byTimestamp(orphanedSiblings);
    byTimestamp(orphanedToolResults);
    inserts.set(assistant.uuid, [...orphanedSiblings, ...orphanedToolResults]);
  }

  if (inserts.size === 0) {
    return chain;
  }

  const result = [];
  for (const entry of chain) {
    result.push(entry);
    const toInsert = inserts.get(entry.uuid);
    if (toInsert) {
      result.push(...toInsert);
    }
  }
  return result;
}

// Stable timestamp sort keeps content-block order; equal timestamps (same
// streamed second) fall back to file order because byUuid preserves it.
function byTimestamp(entries) {
  entries.sort((a, b) => {
    const ta = Date.parse(a.timestamp ?? '') || 0;
    const tb = Date.parse(b.timestamp ?? '') || 0;
    return ta - tb;
  });
}
