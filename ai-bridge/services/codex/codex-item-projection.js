/** Shared native item projection for live streaming and persisted history. */
export function projectCodexItemMessages(item, { threadId = null, turnId = null, authoritative = false, kind = null } = {}) {
  const messages = [];
  if (!item || typeof item !== 'object') return messages;
  const emit = (line) => messages.push(JSON.parse(line.slice('[MESSAGE] '.length)));
    const type = item.type ?? item.itemType;
    const itemId = item.id ?? null;
    const markerMeta = {
      ...(itemId ? { codexItemId: itemId } : {}),
      codexThreadId: threadId,
      codexTurnId: turnId,
      uuid: itemId ? `codex:${threadId}:${turnId}:${itemId}` : undefined,
      codexItemType: type ?? 'unknown',
      ...(item.phase ? { codexPhase: item.phase } : {}),
      codexAuthoritative: authoritative,
      codexSnapshot: true,
    };
    const emitAssistant = (content) => {
      if (!Array.isArray(content) || content.length === 0) return messages;
      emit( `[MESSAGE] ${JSON.stringify({
        type: 'assistant',
        ...markerMeta,
        message: { role: 'assistant', content },
      })}`);
    };
    const emitToolResult = (toolUseId, content, isError = false) => {
      emit( `[MESSAGE] ${JSON.stringify({
        type: 'user',
        ...markerMeta,
        codexItemId: itemId ? `${itemId}:result` : undefined,
        uuid: itemId ? `codex:${threadId}:${turnId}:${itemId}:result` : undefined,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId ?? '',
            is_error: isError,
            content: typeof content === 'string' || Array.isArray(content) ? content : JSON.stringify(content ?? ''),
          }],
        },
      })}`);
    };
    if (type === 'userMessage' || type === 'user_message') {
      emit( `[MESSAGE] ${JSON.stringify({
        type: 'user',
        clientMessageId: item.clientId ?? null,
        ...markerMeta,
        message: {
          role: 'user',
          content: Array.isArray(item.content) ? item.content : [],
        },
      })}`);
      return messages;
    }
    if (type === 'agentMessage' || type === 'agent_message') {
      // Some persisted turns carry the body as a plain `content` string while
      // others use `text`; both must render, an unrecognised shape collapses
      // into an empty authoritative message and erases the reply on reload.
      const content = Array.isArray(item.content)
        ? item.content
        : typeof item.text === 'string' ? [{ type: 'text', text: item.text }]
          : typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : [];
      // An authoritative empty item replaces an earlier streamed body too.
      emitAssistant(content.length === 0 && authoritative ? [{ type: 'text', text: '' }] : content);
      return messages;
    }
    if (type === 'imageView' || type === 'ImageView' || type === 'image_view') {
      emitAssistant([{ type: 'tool_use', id: itemId, name: 'imageView', input: { path: item.path } }]);
      if (isTerminalTool(item, authoritative)) {
        emitToolResult(itemId, item.error?.message ?? '', ['failed', 'declined', 'interrupted'].includes(item.status));
      }
      return messages;
    }
    if (type === 'imageGeneration' || type === 'ImageGeneration'
        || type === 'Extension' && item.kind === 'image_gen.generation') {
      const metadata = { revisedPrompt: item.revisedPrompt ?? item.revised_prompt,
        path: item.savedPath ?? item.saved_path, transparentBackground: item.transparentBackground };
      const input = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value != null));
      emitAssistant([{ type: 'tool_use', id: itemId, name: 'imageGeneration', input }]);
      if (isTerminalTool(item, authoritative)) {
        // PNG bytes belong to the result renderer, not the expandable input JSON.
        const content = [];
        if (typeof item.result === 'string' && item.result) {
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: item.result } });
        }
        if (metadata.path) content.push({ type: 'text', text: metadata.path });
        if (item.failure != null) content.push({ type: 'text', text: JSON.stringify(item.failure) });
        emitToolResult(itemId, content, item.failure != null || ['failed', 'declined', 'interrupted'].includes(item.status));
      }
      return messages;
    }
    if (type === 'webSearch' || type === 'WebSearch' || type === 'web_search'
        || type === 'Extension' && item.kind === 'web.search') {
      const input = Object.fromEntries(['query', 'action', 'results']
        .filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));
      emitAssistant([{ type: 'tool_use', id: itemId, name: 'webSearch', input }]);
      if (isTerminalTool(item, authoritative)) {
        const output = item.error?.message ?? item.output ?? item.results ?? '';
        emitToolResult(itemId, typeof output === 'string' ? output : JSON.stringify(output),
          ['failed', 'declined', 'interrupted'].includes(item.status));
      }
      return messages;
    }
    if (type === 'commandExecution' || type === 'command_execution') {
      const command = item.command ?? item.cmd ?? '';
      const toolId = itemId ?? `codex-command-${Date.now()}`;
      emitAssistant([{
        type: 'tool_use',
        id: toolId,
        name: 'bash',
        input: {
          command,
          ...Object.fromEntries(['description', 'summary', 'title', 'justification', 'approvalReason']
            .filter((field) => typeof item[field] === 'string' && item[field].trim())
            .map((field) => [field, item[field]])),
          ...(item.cwd ? { cwd: item.cwd } : {}),
          ...(item.commandActions ? { commandActions: item.commandActions } : {}),
        },
      }]);
      // Output is a snapshot, not a terminal signal. Full history can also
      // contain a command that is still running in another window.
      if (isTerminalTool(item, authoritative)) {
        const output = item.aggregatedOutput ?? item.output ?? item.stdout ?? item.stderr ?? '';
        emitToolResult(toolId, output, ['failed', 'declined', 'interrupted'].includes(item.status)
          || typeof item.exitCode === 'number' && item.exitCode !== 0);
      }
      return messages;
    }
    if (type === 'mcpToolCall' || type === 'mcp_tool_call') {
      const toolId = itemId ?? `codex-mcp-${Date.now()}`;
      emitAssistant([{
        type: 'tool_use',
        id: toolId,
        name: item.tool ?? item.name ?? 'mcp',
        input: {
          server: item.server,
          arguments: item.arguments ?? item.input ?? {},
        },
      }]);
      if (isTerminalTool(item, authoritative) || !item.status && (item.result != null || item.error != null)) {
        emitToolResult(toolId, item.error?.message ?? projectMcpResult(item.result) ?? '',
          Boolean(item.error) || ['failed', 'declined', 'interrupted'].includes(item.status));
      }
      return messages;
    }
    if (type === 'dynamicToolCall') {
      const toolId = itemId ?? `codex-dynamic-${Date.now()}`;
      const input = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
        ? item.arguments : { patch: item.arguments ?? '' };
      emitAssistant([{ type: 'tool_use', id: toolId,
        name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, input }]);
      if (isTerminalTool(item, authoritative)) {
        const content = (item.contentItems ?? []).map((entry) => entry.type === 'inputText'
          ? { type: 'text', text: entry.text }
          : entry.type === 'inputImage' ? { type: 'image', source: { type: 'url', url: entry.imageUrl } } : entry);
        emitToolResult(toolId, content, item.status === 'failed' || item.status === 'interrupted' || item.success === false);
      }
      return messages;
    }
    if (type === 'reasoning') {
      const texts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
        .map((entry) => typeof entry === 'string' ? entry : entry?.text).filter((entry) => typeof entry === 'string' && entry);
      // A native reasoning item proves activity even when its readable summary is unavailable.
      const status = item.status ?? (authoritative ? 'completed' : 'inProgress');
      const blocks = (texts.length ? texts : ['']).map((text) => ({
        type: 'thinking', thinking: text, text, native: true, status,
      }));
      emitAssistant(blocks);
      return messages;
    }
    if (type === 'fileChange' || type === 'file_change') {
      const changes = normalizeFileChanges(item.changes ?? item.fileChanges ?? item.files);
      emitAssistant([{
        type: 'tool_use',
        id: itemId ?? `codex-file-change-${Date.now()}`,
        name: 'file_change',
        input: {
          changes,
          status: item.status ?? (authoritative && !item.proposed ? 'completed' : null),
          proposed: item.proposed ?? item.status === 'proposed',
          authoritative,
        },
      }]);
      return messages;
    }
    if (type === 'functionCallOutput' || type === 'function_call_output') {
      emitToolResult(item.callId ?? item.call_id ?? itemId, item.output ?? item.result ?? '', item.status === 'failed');
      return messages;
    }
    if (type === 'plan') {
      emitAssistant([{
        type: 'tool_use',
        id: itemId ?? `codex-plan-item-${Date.now()}`,
        name: 'codex_plan',
        input: {
          text: item.text ?? item.plan ?? '',
          status: item.status ?? null,
          authoritative,
        },
      }]);
      return messages;
    }
    if (type === 'contextCompaction' || type === 'context_compaction') {
      const summary = item.summary ?? item.text ?? item.content ?? '';
      emit( `[MESSAGE] ${JSON.stringify({
        type: 'assistant',
        ...markerMeta,
        isCompactSummary: true,
        summarizeMetadata: {
          ...(item.trigger ? { trigger: item.trigger } : kind ? { trigger: kind === 'compact' ? 'manual' : 'auto' } : {}),
          native: true,
          status: item.status ?? (authoritative ? 'completed' : 'inProgress'),
          itemId,
        },
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: typeof summary === 'string' ? summary : JSON.stringify(summary) }],
        },
      })}`);
      return messages;
    }
    if ((type === 'collabAgentToolCall' || type === 'collab_agent_tool_call') && item.tool === 'spawnAgent') {
      const receivers = item.receiverThreadIds ?? [];
      emitAssistant([{ type: 'tool_use', id: itemId, name: 'spawn_agent', input: {
        agent_id: receivers[0], receiverThreadIds: receivers, agentsStates: item.agentsStates ?? {},
        run_in_background: true, native: true, model: item.model, reasoning_effort: item.reasoningEffort,
        ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
        status: item.status,
      } }]);
      if (isTerminalTool(item, authoritative)) {
        const failed = ['failed', 'declined', 'interrupted'].includes(item.status);
        emitToolResult(itemId, failed ? 'Native agent launch ' + item.status : { agent_id: receivers[0] }, failed);
      }
      return messages;
    }
    if (type === 'collabAgentToolCall' || type === 'collab_agent_tool_call') {
      emitAssistant([{ type: 'tool_use', id: itemId, name: 'collabAgentToolCall', input: {
        tool: item.tool, receiverThreadIds: item.receiverThreadIds ?? [], agentsStates: item.agentsStates ?? {},
        ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
        status: item.status,
      } }]);
      if (isTerminalTool(item, authoritative)) {
        emitToolResult(itemId, item.error?.message ?? { agentsStates: item.agentsStates ?? {} },
          ['failed', 'declined', 'interrupted'].includes(item.status));
      }
      return messages;
    }
    if (type) {
      const input = { ...item };
      delete input.type;
      delete input.id;
      emitAssistant([{
        type: 'tool_use',
        id: itemId ?? `codex-${String(type).toLowerCase()}-${Date.now()}`,
        name: String(type),
        input,
      }]);
    }
  return messages;
}

function normalizeFileChanges(changes) {
  if (Array.isArray(changes)) {
    return changes.map((change) => ({ ...change }));
  }
  if (!changes || typeof changes !== 'object') {
    return [];
  }
  return Object.entries(changes).map(([path, change]) => ({
    ...(change && typeof change === 'object' ? change : { diff: change }),
    path: change?.path ?? path,
  }));
}

function isTerminalTool(item, authoritative) {
  return ['completed', 'failed', 'declined', 'interrupted'].includes(item.status)
    || !item.status && authoritative;
}

function projectMcpResult(result) {
  if (!Array.isArray(result?.content)) return result;
  const blocks = result.content.map((block) => block?.type === 'image'
    && typeof block.data === 'string' && typeof block.mimeType === 'string'
    ? { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } } : block);
  if (result.structuredContent != null) {
    blocks.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  }
  return blocks;
}
