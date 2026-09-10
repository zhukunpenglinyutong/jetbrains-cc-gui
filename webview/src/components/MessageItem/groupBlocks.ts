import type { ClaudeContentBlock } from '../../types';
import { READ_TOOL_NAMES, EDIT_TOOL_NAMES, BASH_TOOL_NAMES, SEARCH_TOOL_NAMES, AGENT_TOOL_NAMES, isToolName } from '../../utils/toolConstants';

export type GroupedBlock =
  | { type: 'single'; block: ClaudeContentBlock; originalIndex: number }
  | { type: 'read_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'edit_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'bash_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'search_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'agent_group'; agentBlock: ClaudeContentBlock; followingBlocks: ClaudeContentBlock[]; startIndex: number };

function isToolBlockOfType(block: ClaudeContentBlock, toolNames: Set<string>): boolean {
  return block.type === 'tool_use' && isToolName(block.name, toolNames);
}

// Groups consecutive content blocks for rendering. Agent groups absorb the
// tool_use blocks that follow them using a purely structural rule (see the
// forEach below), so live streaming and history reload yield identical groups.
// Re-exported through MessageItem.tsx for unit testing.
export function groupBlocks(blocks: ClaudeContentBlock[]): GroupedBlock[] {
  const groupedBlocks: GroupedBlock[] = [];
  let currentReadGroup: ClaudeContentBlock[] = [];
  let readGroupStartIndex = -1;
  let currentEditGroup: ClaudeContentBlock[] = [];
  let editGroupStartIndex = -1;
  let currentBashGroup: ClaudeContentBlock[] = [];
  let bashGroupStartIndex = -1;
  let currentSearchGroup: ClaudeContentBlock[] = [];
  let searchGroupStartIndex = -1;
  let currentAgentBlock: ClaudeContentBlock | null = null;
  let agentFollowingText: ClaudeContentBlock[] = [];
  let agentGroupStartIndex = -1;

  const flushReadGroup = () => {
    if (currentReadGroup.length > 0) {
      groupedBlocks.push({
        type: 'read_group',
        blocks: [...currentReadGroup],
        startIndex: readGroupStartIndex,
      });
      currentReadGroup = [];
      readGroupStartIndex = -1;
    }
  };

  const flushEditGroup = () => {
    if (currentEditGroup.length > 0) {
      groupedBlocks.push({
        type: 'edit_group',
        blocks: [...currentEditGroup],
        startIndex: editGroupStartIndex,
      });
      currentEditGroup = [];
      editGroupStartIndex = -1;
    }
  };

  const flushBashGroup = () => {
    if (currentBashGroup.length > 0) {
      groupedBlocks.push({
        type: 'bash_group',
        blocks: [...currentBashGroup],
        startIndex: bashGroupStartIndex,
      });
      currentBashGroup = [];
      bashGroupStartIndex = -1;
    }
  };

  const flushSearchGroup = () => {
    if (currentSearchGroup.length > 0) {
      groupedBlocks.push({
        type: 'search_group',
        blocks: [...currentSearchGroup],
        startIndex: searchGroupStartIndex,
      });
      currentSearchGroup = [];
      searchGroupStartIndex = -1;
    }
  };

  const flushAgentGroup = () => {
    if (currentAgentBlock) {
      groupedBlocks.push({
        type: 'agent_group',
        agentBlock: currentAgentBlock,
        followingBlocks: [...agentFollowingText],
        startIndex: agentGroupStartIndex,
      });
      currentAgentBlock = null;
      agentFollowingText = [];
      agentGroupStartIndex = -1;
    }
  };

  blocks.forEach((block, idx) => {
    // While inside an agent group, absorb subsequent tool_use blocks until a
    // structural boundary: the next agent tool, a non-tool block (text/thinking),
    // or the end of the message. Keeping this purely structural guarantees that
    // live streaming and history reload produce identical groups — the previous
    // streaming-only "frozen count" could not be reconstructed from a snapshot,
    // so reloaded agent groups dropped all their absorbed children.
    if (currentAgentBlock) {
      if (isToolBlockOfType(block, AGENT_TOOL_NAMES)) {
        // Next agent tool — close this group and open a new one below.
        flushAgentGroup();
      } else if (block.type === 'tool_use') {
        // Absorb the following tool_use into the running agent group.
        agentFollowingText.push(block);
        return;
      } else {
        // Non-tool block (text/thinking/...) ends the group; process it normally.
        flushAgentGroup();
      }
    }

    if (isToolBlockOfType(block, AGENT_TOOL_NAMES)) {
      flushReadGroup();
      flushEditGroup();
      flushBashGroup();
      flushSearchGroup();
      currentAgentBlock = block;
      agentGroupStartIndex = idx;
    } else if (isToolBlockOfType(block, READ_TOOL_NAMES)) {
      flushEditGroup();
      flushBashGroup();
      flushSearchGroup();
      if (currentReadGroup.length === 0) {
        readGroupStartIndex = idx;
      }
      currentReadGroup.push(block);
    } else if (isToolBlockOfType(block, EDIT_TOOL_NAMES)) {
      flushReadGroup();
      flushBashGroup();
      flushSearchGroup();
      if (currentEditGroup.length === 0) {
        editGroupStartIndex = idx;
      }
      currentEditGroup.push(block);
    } else if (isToolBlockOfType(block, BASH_TOOL_NAMES)) {
      flushReadGroup();
      flushEditGroup();
      flushSearchGroup();
      if (currentBashGroup.length === 0) {
        bashGroupStartIndex = idx;
      }
      currentBashGroup.push(block);
    } else if (isToolBlockOfType(block, SEARCH_TOOL_NAMES)) {
      flushReadGroup();
      flushEditGroup();
      flushBashGroup();
      if (currentSearchGroup.length === 0) {
        searchGroupStartIndex = idx;
      }
      currentSearchGroup.push(block);
    } else {
      flushReadGroup();
      flushEditGroup();
      flushBashGroup();
      flushSearchGroup();
      groupedBlocks.push({ type: 'single', block, originalIndex: idx });
    }
  });

  flushAgentGroup();
  flushReadGroup();
  flushEditGroup();
  flushBashGroup();
  flushSearchGroup();

  return groupedBlocks;
}
