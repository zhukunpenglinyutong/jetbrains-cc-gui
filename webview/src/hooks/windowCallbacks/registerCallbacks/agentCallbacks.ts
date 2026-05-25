/**
 * agentCallbacks.ts
 *
 * Registers window bridge callbacks for agent management and selection context:
 * addSelectionInfo, addCodeSnippet, clearSelectionInfo,
 * onSelectedAgentReceived, onSelectedAgentChanged.
 *
 * Agent selection is scoped per provider. When the backend sends an agent
 * selection via the bridge, it is stored in the current provider's slot in
 * the agentsByProvider map.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { SelectedAgent } from '../../../components/ChatInputBox/types';

function parseAgentJson(json: string | null | undefined): SelectedAgent | null {
  if (!json || json === 'null' || json === '{}') {
    return null;
  }
  const data = JSON.parse(json);
  const agentFromNewShape = data?.agent;
  const agentFromLegacyShape = data;
  const agentData = agentFromNewShape?.id
    ? agentFromNewShape
    : agentFromLegacyShape?.id
      ? agentFromLegacyShape
      : null;
  if (!agentData) {
    return null;
  }
  return {
    id: agentData.id,
    name: agentData.name || '',
    prompt: agentData.prompt,
  };
}

export function registerAgentAndSelectionCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setContextInfo,
    setAgentsByProvider,
    currentProviderRef,
  } = options;

  window.addSelectionInfo = (selectionInfo) => {
    if (selectionInfo) {
      const match = selectionInfo.match(/^@([^#]+)(?:#L(\d+)(?:-(\d+))?)?$/);
      if (match) {
        const file = match[1];
        const startLine = match[2] ? parseInt(match[2], 10) : undefined;
        const endLine =
          match[3] ? parseInt(match[3], 10) : startLine !== undefined ? startLine : undefined;
        setContextInfo({
          file,
          startLine,
          endLine,
          raw: selectionInfo,
        });
      }
    }
  };

  window.addCodeSnippet = (selectionInfo) => {
    if (selectionInfo && window.insertCodeSnippetAtCursor) {
      window.insertCodeSnippetAtCursor(selectionInfo);
    }
  };

  window.clearSelectionInfo = () => {
    setContextInfo(null);
  };

  window.onSelectedAgentReceived = (json) => {
    try {
      const agent = parseAgentJson(json);
      const provider = currentProviderRef.current;
      setAgentsByProvider(prev => ({ ...prev, [provider]: agent }));
    } catch (error) {
      console.error('[Frontend] Failed to parse selected agent:', error);
      setAgentsByProvider(prev => ({ ...prev, [currentProviderRef.current]: null }));
    }
  };

  window.onSelectedAgentChanged = (json) => {
    try {
      const data = json ? JSON.parse(json) : null;
      if (data && data?.success === false) {
        return;
      }
      const agent = parseAgentJson(json);
      const provider = currentProviderRef.current;
      setAgentsByProvider(prev => ({ ...prev, [provider]: agent }));
    } catch (error) {
      console.error('[Frontend] Failed to parse selected agent changed:', error);
    }
  };
}