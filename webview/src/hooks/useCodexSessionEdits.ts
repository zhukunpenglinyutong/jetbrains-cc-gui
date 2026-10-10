import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeMessage, ClaudeRawMessage } from '../types';
import { sendToJava } from '../utils/bridge';

/** Reads the file ledger without expanding every historical message into the chat. */
export function useCodexSessionEdits(provider: string, sessionId: string | null,
  messages: ClaudeMessage[], streaming: boolean): ClaudeMessage[] {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; messages: ClaudeMessage[] } | null>(null);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (provider !== 'codex' || !sessionId) return;
    const receive = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.requestType !== 'codex_native_read_thread' || data.requestId !== pending.current
        || data.thread?.id !== sessionId || !Array.isArray(data.fileChangeMessages) || data.error) return;
      pending.current = null;
      if (typeof data.thread.name === 'string' && data.thread.name.trim()) {
        window.updateSessionTitle?.(sessionId, data.thread.name);
      }
      setSnapshot({ sessionId, messages: data.fileChangeMessages.map((raw: ClaudeRawMessage) => ({
        type: raw.type, raw,
      })) });
    };
    window.addEventListener('codex-native-data', receive);
    return () => { pending.current = null; window.removeEventListener('codex-native-data', receive); };
  }, [provider, sessionId]);
  useEffect(() => {
    if (provider !== 'codex' || !sessionId || streaming) return;
    const requestId = `session-edits-${crypto.randomUUID()}`;
    pending.current = requestId;
    sendToJava('codex_native_read_thread', { threadId: sessionId, requestId, params: { includeTurns: true, fileChangesOnly: true } });
  }, [provider, sessionId, streaming]);

  return useMemo(() => {
    if (provider !== 'codex' || snapshot?.sessionId !== sessionId) return messages;
    // Native item IDs unify saved and live snapshots. A native file-only
    // projection cannot erase legacy tools omitted by that protocol surface.
    const merged = new Map<string, ClaudeMessage>();
    for (const message of [...snapshot.messages, ...messages]) {
      if (message.type !== 'assistant' || !message.raw || typeof message.raw !== 'object') continue;
      if (message.raw.codexThreadId && message.raw.codexThreadId !== sessionId) continue;
      const content = message.raw.message?.content ?? message.raw.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== 'tool_use' || block.name !== 'file_change' || !block.id) continue;
        const previous = merged.get(block.id)?.raw;
        const previousBlocks = previous && typeof previous === 'object' ? previous.message?.content : undefined;
        const previousBlock = Array.isArray(previousBlocks) ? previousBlocks[0] : undefined;
        const previousInput = previousBlock?.type === 'tool_use' ? previousBlock.input : undefined;
        if (previousInput?.status === 'completed' && block.input?.status !== 'completed') continue;
        merged.set(block.id, { ...message, raw: { ...message.raw, message: { content: [block] } } });
      }
    }
    const visibleNativeIds = new Set<string>();
    const retained = messages.flatMap(message => {
      if (message.type !== 'assistant' || !message.raw || typeof message.raw !== 'object') return [message];
      // Same thread guard as the merge loop: a cross-thread message never
      // entered `merged`, so its file_change blocks must not be dropped here.
      if (message.raw.codexThreadId && message.raw.codexThreadId !== sessionId) return [message];
      const content = message.raw.message?.content ?? message.raw.content;
      if (!Array.isArray(content)) return [message];
      const blocks = content.flatMap(block => {
        if (block.type !== 'tool_use' || block.name !== 'file_change' || !block.id) return [block];
        const canonical = merged.get(block.id)?.raw;
        if (!canonical || typeof canonical !== 'object' || visibleNativeIds.has(block.id)) return [];
        visibleNativeIds.add(block.id);
        const canonicalBlocks = canonical.message?.content;
        return Array.isArray(canonicalBlocks) ? canonicalBlocks : [block];
      });
      if (blocks.length === content.length && blocks.every((block, index) => block === content[index])) return [message];
      if (!blocks.length) return [];
      return [{ ...message, raw: { ...message.raw, message: { ...message.raw.message, content: blocks } } }];
    });
    // Preserve the visible operation order; only edits outside the loaded page precede it.
    return [...merged.entries()].filter(([id]) => !visibleNativeIds.has(id)).map(([, message]) => message).concat(retained);
  }, [provider, sessionId, snapshot, messages]);
}
