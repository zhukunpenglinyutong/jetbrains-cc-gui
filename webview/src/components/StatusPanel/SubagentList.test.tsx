import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import SubagentList from './SubagentList';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({ sendBridgeEvent: sendBridgeEventMock }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('SubagentList', () => {
  it('loads Codex history with provider and agent path', async () => {
    const subagent: SubagentInfo = {
      id: 'call-spawn',
      type: 'audit',
      description: 'Review anchors',
      prompt: 'Review anchors',
      status: 'running',
      isAsync: true,
      messageIndex: 0,
      agentPath: 'audit_ui',
    };

    render(
      <SubagentList
        subagents={[subagent]}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'load_subagent_session',
      JSON.stringify({
        sessionId: 'session-1',
        provider: 'codex',
        agentPath: 'audit_ui',
        description: 'Review anchors',
        toolUseId: 'call-spawn',
      }),
    ));
  });

  it('loads the full transcript when only a lightweight status snapshot exists', async () => {
    const subagent: SubagentInfo = {
      id: 'call-spawn',
      type: 'audit',
      description: 'Review anchors',
      status: 'running',
      isAsync: true,
      messageIndex: 0,
      agentPath: 'audit_ui',
    };
    const histories: Record<string, SubagentHistoryResponse> = {
      'call-spawn': {
        success: true,
        completed: false,
        status: 'running',
        toolUseId: 'call-spawn',
        agentId: 'agent-resolved',
        agentPath: '/root/audit_ui',
      },
    };

    render(
      <SubagentList
        subagents={[subagent]}
        histories={histories}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'load_subagent_session',
      JSON.stringify({
        sessionId: 'session-1',
        provider: 'codex',
        agentId: 'agent-resolved',
        agentPath: '/root/audit_ui',
        description: 'Review anchors',
        toolUseId: 'call-spawn',
      }),
    ));
  });
});
