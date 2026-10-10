import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { PlanApprovalRequest } from '../components/PlanApprovalDialog';
import type { RewindRequest } from '../components/RewindDialog';
import type { ContextUsageData } from '../components/ContextUsageDialog';
import { openBrowserExternal, sendBridgeEvent } from '../utils/bridge';
import { clearDialogDraft, type DialogDraftKind } from '../utils/dialogStateStorage';

const CLOSED_DIALOG_TOKEN_LIMIT = 256;

/** Convert the UI answer map to Codex's native requestUserInput union. */
export function buildCodexUserInputAnswers(
  answers: Record<string, string | string[]>,
): Record<string, { answers: string[] }> {
  return Object.fromEntries(Object.entries(answers).map(([questionId, answer]) => [
    questionId,
    { answers: Array.isArray(answer) ? answer.map(String) : [String(answer)] },
  ]));
}

/** Build the native permissions profile response without converting it to a boolean decision. */
export function buildCodexPermissionApprovalResult(
  inputs: Record<string, unknown> | undefined,
  scope: 'turn' | 'session',
): { permissions: Record<string, unknown>; scope: 'turn' | 'session' } {
  const source = inputs?.permissions ?? inputs?.requestedPermissions ?? inputs?.requested_permissions;
  const permissions = source && typeof source === 'object' && !Array.isArray(source)
    ? { ...(source as Record<string, unknown>) }
    : {};
  return { permissions, scope };
}

/** Build the structured content required by the MCP elicitation response union. */
export function buildCodexElicitationContent(
  answers: Record<string, string | string[]>,
  requestedSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const properties = requestedSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return { ...answers };
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [name, answer] of Object.entries(answers)) {
    const schema = (properties as Record<string, unknown>)[name];
    const type = schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as Record<string, unknown>).type
      : undefined;
    if (type === 'array') {
      result[name] = Array.isArray(answer) ? answer.map(String) : [String(answer)];
    } else {
      const value = Array.isArray(answer) ? answer[0] : answer;
      if (type === 'boolean' && (value === 'true' || value === 'false')) {
        result[name] = value === 'true';
      } else if ((type === 'number' || type === 'integer') && value !== undefined
          && value !== '' && Number.isFinite(Number(value))) {
        result[name] = Number(value);
      } else {
        result[name] = value ?? '';
      }
    }
  }
  return result;
}

function rememberClosedDialog(tokens: Set<string>, token?: string): void {
  if (!token) return;
  tokens.add(token);
  if (tokens.size > CLOSED_DIALOG_TOKEN_LIMIT) {
    tokens.delete(tokens.values().next().value!);
  }
}

function declineAskUserQuestion(
  closedTokens: Set<string>,
  request: { requestId: string; dialogToken?: string },
): void {
  rememberClosedDialog(closedTokens, request.dialogToken);
  sendBridgeEvent('ask_user_question_response', JSON.stringify({
    requestId: request.requestId,
    dialogToken: request.dialogToken,
    answers: {},
  }));
}

function dropQueuedGrokQuestions(
  pending: AskUserQuestionRequest[],
  closedTokens: Set<string>,
  keep: AskUserQuestionRequest,
): AskUserQuestionRequest[] {
  return pending.filter((item) => {
    if (item.provider !== 'grok') return true;
    if (item.requestId === keep.requestId && item.dialogToken === keep.dialogToken) return true;
    declineAskUserQuestion(closedTokens, item);
    return false;
  });
}

interface ForceCloseableRequest {
  dialogToken?: string;
}

// Replayed closes must target the exact request; reused IDs and deadlines cannot identify a generation.
function applyForceClose<T extends ForceCloseableRequest>(
  targetId: string | null,
  dialogToken: string | undefined,
  kind: DialogDraftKind,
  closedTokens: Set<string>,
  currentRef: { current: T | null },
  pendingRef: { current: T[] },
  getId: (item: T) => string,
  closeActive: () => void,
): void {
  rememberClosedDialog(closedTokens, dialogToken);
  if (targetId !== null && dialogToken) clearDialogDraft(kind, targetId, dialogToken);
  const matches = (item: T) => targetId === null
    || (getId(item) === targetId && (!dialogToken || item.dialogToken === dialogToken));
  const discard = (item: T) => {
    rememberClosedDialog(closedTokens, item.dialogToken);
    if (targetId === null || !dialogToken) clearDialogDraft(kind, getId(item), item.dialogToken);
  };
  pendingRef.current = pendingRef.current.filter((item) => {
    if (!matches(item)) return true;
    discard(item);
    return false;
  });
  if (currentRef.current && matches(currentRef.current)) {
    discard(currentRef.current);
    closeActive();
  }
}

interface UseDialogManagementOptions {
  t: TFunction;
}

interface UseDialogManagementReturn {
  // Permission dialog
  permissionDialogOpen: boolean;
  currentPermissionRequest: PermissionRequest | null;
  openPermissionDialog: (request: PermissionRequest) => void;
  handlePermissionApprove: (channelId: string) => void | boolean;
  handlePermissionApproveAlways: (channelId: string) => void | boolean;
  handlePermissionSkip: (channelId: string) => void | boolean;
  handlePermissionCancel: (channelId: string) => void | boolean;
  handlePermissionDecision: (channelId: string, decision: Record<string, unknown>) => void | boolean;
  forceClosePermissionDialog: (channelId?: string | null, dialogToken?: string) => void;

  // AskUserQuestion dialog
  askUserQuestionDialogOpen: boolean;
  currentAskUserQuestionRequest: AskUserQuestionRequest | null;
  openAskUserQuestionDialog: (request: AskUserQuestionRequest) => void;
  handleAskUserQuestionSubmit: (requestId: string, answers: Record<string, string | string[]>) => void | boolean;
  handleAskUserQuestionCancel: (requestId: string) => void | boolean;
  forceCloseAskUserQuestionDialog: (requestId?: string | null, dialogToken?: string) => void;

  // PlanApproval dialog
  planApprovalDialogOpen: boolean;
  currentPlanApprovalRequest: PlanApprovalRequest | null;
  openPlanApprovalDialog: (request: PlanApprovalRequest) => void;
  handlePlanApprovalApprove: (requestId: string, targetMode: string) => void;
  handlePlanApprovalReject: (requestId: string) => void;
  forceClosePlanApprovalDialog: (requestId?: string | null, dialogToken?: string) => void;

  // Rewind dialog
  rewindDialogOpen: boolean;
  setRewindDialogOpen: (open: boolean) => void;
  currentRewindRequest: RewindRequest | null;
  setCurrentRewindRequest: (request: RewindRequest | null) => void;
  isRewinding: boolean;
  setIsRewinding: (loading: boolean) => void;

  // Rewind select dialog
  rewindSelectDialogOpen: boolean;
  setRewindSelectDialogOpen: (open: boolean) => void;

  // Context usage dialog
  contextUsageDialogOpen: boolean;
  contextUsageIsLoading: boolean;
  contextUsageData: ContextUsageData | null;
  openContextUsageDialog: (requestId?: string | null, loading?: boolean) => void;
  updateContextUsageData: (requestId: string | null | undefined, data: ContextUsageData) => boolean;
  closeContextUsageDialog: (requestId?: string | null) => boolean;
}

/**
 * Hook for managing dialog states (permission, ask user question, rewind)
 */
export function useDialogManagement({ t }: UseDialogManagementOptions): UseDialogManagementReturn {
  // Permission dialog state
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);
  const currentPermissionRequestRef = useRef<PermissionRequest | null>(null);
  const pendingPermissionRequestsRef = useRef<PermissionRequest[]>([]);
  const closedPermissionTokensRef = useRef(new Set<string>());

  // AskUserQuestion dialog state
  const [askUserQuestionDialogOpen, setAskUserQuestionDialogOpen] = useState(false);
  const [currentAskUserQuestionRequest, setCurrentAskUserQuestionRequest] = useState<AskUserQuestionRequest | null>(null);
  const currentAskUserQuestionRequestRef = useRef<AskUserQuestionRequest | null>(null);
  const pendingAskUserQuestionRequestsRef = useRef<AskUserQuestionRequest[]>([]);
  const closedAskUserQuestionTokensRef = useRef(new Set<string>());

  // PlanApproval dialog state
  const [planApprovalDialogOpen, setPlanApprovalDialogOpen] = useState(false);
  const [currentPlanApprovalRequest, setCurrentPlanApprovalRequest] = useState<PlanApprovalRequest | null>(null);
  const currentPlanApprovalRequestRef = useRef<PlanApprovalRequest | null>(null);
  const pendingPlanApprovalRequestsRef = useRef<PlanApprovalRequest[]>([]);
  const closedPlanApprovalTokensRef = useRef(new Set<string>());

  // Rewind dialog state
  const [rewindDialogOpen, setRewindDialogOpen] = useState(false);
  const [currentRewindRequest, setCurrentRewindRequest] = useState<RewindRequest | null>(null);
  const [isRewinding, setIsRewinding] = useState(false);

  // Rewind select dialog state
  const [rewindSelectDialogOpen, setRewindSelectDialogOpen] = useState(false);

  // Context usage dialog state
  const [contextUsageDialogOpen, setContextUsageDialogOpen] = useState(false);
  const [contextUsageIsLoading, setContextUsageIsLoading] = useState(false);
  const [contextUsageData, setContextUsageData] = useState<ContextUsageData | null>(null);
  const contextUsageRequestIdRef = useRef<string | null>(null);

  // Open permission dialog
  const openPermissionDialog = useCallback((request: PermissionRequest) => {
    if (request.dialogToken && closedPermissionTokensRef.current.has(request.dialogToken)) {
      return;
    }
    // If a permission dialog is currently open, enqueue the new request instead of overriding.
    // This avoids losing follow-up requests when the user denies the current one.
    if (currentPermissionRequestRef.current) {
      const currentId = currentPermissionRequestRef.current?.channelId;
      const alreadyQueued = pendingPermissionRequestsRef.current.some(
        (item) => item.channelId === request.channelId && item.dialogToken === request.dialogToken
      );
      if ((request.channelId !== currentId || request.dialogToken !== currentPermissionRequestRef.current?.dialogToken) && !alreadyQueued) {
        pendingPermissionRequestsRef.current.push(request);
      }
      return;
    }

    currentPermissionRequestRef.current = request;
    setCurrentPermissionRequest(request);
    setPermissionDialogOpen(true);
  }, []);

  // Open ask user question dialog
  const openAskUserQuestionDialog = useCallback((request: AskUserQuestionRequest) => {
    if (request.dialogToken && closedAskUserQuestionTokensRef.current.has(request.dialogToken)) {
      return;
    }
    // A newer Grok question retires every earlier Grok question. The bridge has
    // already declined those ACP ids, so their dialogs must answer IPC and must
    // not surface later. Claude, Codex, and DSH questions stay queued.
    if (request.provider === 'grok') {
      pendingAskUserQuestionRequestsRef.current = dropQueuedGrokQuestions(
        pendingAskUserQuestionRequestsRef.current,
        closedAskUserQuestionTokensRef.current,
        request,
      );
    }
    // If an ask user question dialog is currently open, enqueue the new request instead of overriding.
    // This avoids losing follow-up requests when multiple questions arrive in quick succession.
    // Grok replaces the open question: the previous ACP id is already declined, so the
    // visible dialog must close and answer its IPC before the new one is shown.
    if (currentAskUserQuestionRequestRef.current) {
      const current = currentAskUserQuestionRequestRef.current;
      const currentId = current.requestId;
      if (
        request.provider === 'grok'
        && current.provider === 'grok'
        && (request.requestId !== currentId || request.dialogToken !== current.dialogToken)
      ) {
        declineAskUserQuestion(closedAskUserQuestionTokensRef.current, current);
        currentAskUserQuestionRequestRef.current = request;
        setCurrentAskUserQuestionRequest(request);
        setAskUserQuestionDialogOpen(true);
        return;
      }
      const alreadyQueued = pendingAskUserQuestionRequestsRef.current.some(
        (item) => item.requestId === request.requestId && item.dialogToken === request.dialogToken
      );
      if ((request.requestId !== currentId || request.dialogToken !== currentAskUserQuestionRequestRef.current?.dialogToken) && !alreadyQueued) {
        pendingAskUserQuestionRequestsRef.current.push(request);
      }
      return;
    }

    currentAskUserQuestionRequestRef.current = request;
    setCurrentAskUserQuestionRequest(request);
    setAskUserQuestionDialogOpen(true);
  }, []);

  // Open plan approval dialog
  const openPlanApprovalDialog = useCallback((request: PlanApprovalRequest) => {
    if (request.dialogToken && closedPlanApprovalTokensRef.current.has(request.dialogToken)) {
      return;
    }
    // If a plan approval dialog is currently open, enqueue the new request instead of overriding.
    // This avoids losing follow-up requests when multiple plan approval requests arrive in quick succession.
    if (currentPlanApprovalRequestRef.current) {
      const currentId = currentPlanApprovalRequestRef.current?.requestId;
      const alreadyQueued = pendingPlanApprovalRequestsRef.current.some(
        (item) => item.requestId === request.requestId && item.dialogToken === request.dialogToken
      );
      if ((request.requestId !== currentId || request.dialogToken !== currentPlanApprovalRequestRef.current?.dialogToken) && !alreadyQueued) {
        pendingPlanApprovalRequestsRef.current.push(request);
      }
      return;
    }

    currentPlanApprovalRequestRef.current = request;
    setCurrentPlanApprovalRequest(request);
    setPlanApprovalDialogOpen(true);
  }, []);

  // Process pending permission requests queue
  useEffect(() => {
    if (permissionDialogOpen) return;
    if (currentPermissionRequest) return;
    const next = pendingPermissionRequestsRef.current.shift();
    if (next) {
      openPermissionDialog(next);
    }
  }, [permissionDialogOpen, currentPermissionRequest, openPermissionDialog]);

  // Process pending ask user question requests queue
  useEffect(() => {
    if (askUserQuestionDialogOpen) return;
    if (currentAskUserQuestionRequest) return;
    const next = pendingAskUserQuestionRequestsRef.current.shift();
    if (next) {
      openAskUserQuestionDialog(next);
    }
  }, [askUserQuestionDialogOpen, currentAskUserQuestionRequest, openAskUserQuestionDialog]);

  // Process pending plan approval requests queue
  useEffect(() => {
    if (planApprovalDialogOpen) return;
    if (currentPlanApprovalRequest) return;
    const next = pendingPlanApprovalRequestsRef.current.shift();
    if (next) {
      openPlanApprovalDialog(next);
    }
  }, [planApprovalDialogOpen, currentPlanApprovalRequest, openPlanApprovalDialog]);

  // Permission handlers
  const handlePermissionApprove = useCallback((channelId: string) => {
    const current = currentPermissionRequestRef.current;
    if (current?.codexInteractionKey) {
      const result = current.codexMethod === 'item/permissions/requestApproval'
        ? buildCodexPermissionApprovalResult(current.inputs, 'turn')
        : { decision: 'accept' };
      if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
        interactionKey: current.codexInteractionKey,
        channelId: current.channelId,
        dialogToken: current.dialogToken,
        result,
      })) === false) return false;
      rememberClosedDialog(closedPermissionTokensRef.current, current.dialogToken);
      currentPermissionRequestRef.current = null;
      setPermissionDialogOpen(false);
      setCurrentPermissionRequest(null);
      return;
    }
    const payload = JSON.stringify({
      channelId,
      dialogToken: currentPermissionRequestRef.current?.dialogToken,
      allow: true,
      remember: false,
      rejectMessage: null,
    });
    rememberClosedDialog(closedPermissionTokensRef.current, currentPermissionRequestRef.current?.dialogToken);
    sendBridgeEvent('permission_decision', payload);
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  }, []);

  const handlePermissionApproveAlways = useCallback((channelId: string) => {
    const current = currentPermissionRequestRef.current;
    if (current?.codexInteractionKey) {
      const result = current.codexMethod === 'item/permissions/requestApproval'
        ? buildCodexPermissionApprovalResult(current.inputs, 'session')
        : { decision: 'acceptForSession' };
      if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
        interactionKey: current.codexInteractionKey,
        channelId: current.channelId,
        dialogToken: current.dialogToken,
        result,
      })) === false) return false;
      rememberClosedDialog(closedPermissionTokensRef.current, current.dialogToken);
      currentPermissionRequestRef.current = null;
      setPermissionDialogOpen(false);
      setCurrentPermissionRequest(null);
      return;
    }
    const payload = JSON.stringify({
      channelId,
      dialogToken: currentPermissionRequestRef.current?.dialogToken,
      allow: true,
      remember: true,
      rejectMessage: null,
    });
    rememberClosedDialog(closedPermissionTokensRef.current, currentPermissionRequestRef.current?.dialogToken);
    sendBridgeEvent('permission_decision', payload);
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  }, []);

  const handlePermissionSkip = useCallback((channelId: string) => {
    const current = currentPermissionRequestRef.current;
    if (current?.codexInteractionKey) {
      const result = current.codexMethod === 'item/permissions/requestApproval'
        ? buildCodexPermissionApprovalResult({}, 'turn')
        : { decision: 'decline' };
      if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
        interactionKey: current.codexInteractionKey,
        channelId: current.channelId,
        dialogToken: current.dialogToken,
        result,
      })) === false) return false;
      rememberClosedDialog(closedPermissionTokensRef.current, current.dialogToken);
      currentPermissionRequestRef.current = null;
      setPermissionDialogOpen(false);
      setCurrentPermissionRequest(null);
      return;
    }
    const payload = JSON.stringify({
      channelId,
      dialogToken: currentPermissionRequestRef.current?.dialogToken,
      allow: false,
      remember: false,
      rejectMessage: t('permission.userDenied'),
    });
    rememberClosedDialog(closedPermissionTokensRef.current, currentPermissionRequestRef.current?.dialogToken);
    sendBridgeEvent('permission_decision', payload);
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  }, [t]);

  const handlePermissionCancel = useCallback((channelId: string) => {
    const current = currentPermissionRequestRef.current;
    if (current?.codexInteractionKey) {
      const result = current.codexMethod === 'item/permissions/requestApproval'
        ? buildCodexPermissionApprovalResult({}, 'turn')
        : { decision: 'cancel' };
      if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
        interactionKey: current.codexInteractionKey,
        channelId: current.channelId,
        dialogToken: current.dialogToken,
        result,
      })) === false) return false;
      rememberClosedDialog(closedPermissionTokensRef.current, current.dialogToken);
      currentPermissionRequestRef.current = null;
      setPermissionDialogOpen(false);
      setCurrentPermissionRequest(null);
      return;
    }
    const payload = JSON.stringify({
      channelId,
      dialogToken: current?.dialogToken,
      allow: false,
      remember: false,
      rejectMessage: t('permission.userCancelled', 'Permission request cancelled'),
    });
    rememberClosedDialog(closedPermissionTokensRef.current, current?.dialogToken);
    sendBridgeEvent('permission_decision', payload);
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  }, [t]);

  const handlePermissionDecision = useCallback((channelId: string, decision: Record<string, unknown>) => {
    const current = currentPermissionRequestRef.current;
    if (current?.codexInteractionKey) {
      if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
        interactionKey: current.codexInteractionKey,
        channelId: current.channelId,
        dialogToken: current.dialogToken,
        result: decision,
      })) === false) return false;
      rememberClosedDialog(closedPermissionTokensRef.current, current.dialogToken);
      currentPermissionRequestRef.current = null;
      setPermissionDialogOpen(false);
      setCurrentPermissionRequest(null);
      return;
    }
    handlePermissionApprove(channelId);
  }, [handlePermissionApprove]);

  // AskUserQuestion handlers
  const handleAskUserQuestionSubmit = useCallback((requestId: string, answers: Record<string, string | string[]>) => {
    const current = currentAskUserQuestionRequestRef.current;
    if (current?.codexInteractionKey) {
      if (current.codexMethod === 'mcpServer/elicitation/request') {
        const elicitation = current.codexElicitation;
        if (elicitation?.mode === 'url' && elicitation.url) {
          // Opening the URL happens only after the user submits the explicit
          // action option in the dialog. Raw window.open cannot reach the
          // system browser from the JCEF webview; route through the bridge.
          openBrowserExternal(elicitation.url);
        }
        const result: Record<string, unknown> = {
          action: elicitation?.mode === 'userVerification'
            && (Array.isArray(answers.__codex_user_verification__)
              ? answers.__codex_user_verification__[0]
              : answers.__codex_user_verification__) !== 'Confirm'
            ? 'cancel'
            : 'accept',
          content: elicitation?.mode === 'form'
            ? buildCodexElicitationContent(answers, elicitation.requestedSchema)
            : null,
        };
        if (elicitation?.meta !== undefined) result._meta = elicitation.meta;
        if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
          interactionKey: current.codexInteractionKey,
          dialogToken: current.dialogToken,
          result,
        })) === false) return false;
        rememberClosedDialog(closedAskUserQuestionTokensRef.current, current.dialogToken);
        currentAskUserQuestionRequestRef.current = null;
        setAskUserQuestionDialogOpen(false);
        setCurrentAskUserQuestionRequest(null);
        return;
      }
      if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
        interactionKey: current.codexInteractionKey,
        dialogToken: current.dialogToken,
        result: {
          answers: buildCodexUserInputAnswers(answers),
        },
      })) === false) return false;
      rememberClosedDialog(closedAskUserQuestionTokensRef.current, current.dialogToken);
      currentAskUserQuestionRequestRef.current = null;
      setAskUserQuestionDialogOpen(false);
      setCurrentAskUserQuestionRequest(null);
      return;
    }
    const payload = JSON.stringify({
      requestId,
      dialogToken: currentAskUserQuestionRequestRef.current?.dialogToken,
      answers,
    });
    rememberClosedDialog(closedAskUserQuestionTokensRef.current, currentAskUserQuestionRequestRef.current?.dialogToken);
    sendBridgeEvent('ask_user_question_response', payload);
    currentAskUserQuestionRequestRef.current = null;
    setAskUserQuestionDialogOpen(false);
    setCurrentAskUserQuestionRequest(null);
  }, []);

  const handleAskUserQuestionCancel = useCallback((requestId: string) => {
    const current = currentAskUserQuestionRequestRef.current;
    if (current?.codexInteractionKey) {
      if (current.codexMethod === 'mcpServer/elicitation/request') {
        const result: Record<string, unknown> = {
          action: 'cancel',
          content: null,
        };
        if (current.codexElicitation?.meta !== undefined) result._meta = current.codexElicitation.meta;
        if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
          interactionKey: current.codexInteractionKey,
          dialogToken: current.dialogToken,
          result,
        })) === false) return false;
        rememberClosedDialog(closedAskUserQuestionTokensRef.current, current.dialogToken);
        currentAskUserQuestionRequestRef.current = null;
        setAskUserQuestionDialogOpen(false);
        setCurrentAskUserQuestionRequest(null);
        return;
      }
      if (sendBridgeEvent('codex_interaction_response', JSON.stringify({
        interactionKey: current.codexInteractionKey,
        dialogToken: current.dialogToken,
        result: { answers: {} },
      })) === false) return false;
      rememberClosedDialog(closedAskUserQuestionTokensRef.current, current.dialogToken);
      currentAskUserQuestionRequestRef.current = null;
      setAskUserQuestionDialogOpen(false);
      setCurrentAskUserQuestionRequest(null);
      return;
    }
    const payload = JSON.stringify({
      requestId,
      dialogToken: currentAskUserQuestionRequestRef.current?.dialogToken,
      answers: {},
    });
    rememberClosedDialog(closedAskUserQuestionTokensRef.current, currentAskUserQuestionRequestRef.current?.dialogToken);
    sendBridgeEvent('ask_user_question_response', payload);
    currentAskUserQuestionRequestRef.current = null;
    setAskUserQuestionDialogOpen(false);
    setCurrentAskUserQuestionRequest(null);
  }, []);

  // PlanApproval handlers
  const handlePlanApprovalApprove = useCallback((requestId: string, targetMode: string) => {
    const payload = JSON.stringify({
      requestId,
      dialogToken: currentPlanApprovalRequestRef.current?.dialogToken,
      approved: true,
      targetMode,
    });
    rememberClosedDialog(closedPlanApprovalTokensRef.current, currentPlanApprovalRequestRef.current?.dialogToken);
    sendBridgeEvent('plan_approval_response', payload);
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  const handlePlanApprovalReject = useCallback((requestId: string) => {
    const payload = JSON.stringify({
      requestId,
      dialogToken: currentPlanApprovalRequestRef.current?.dialogToken,
      approved: false,
      targetMode: 'default',
    });
    rememberClosedDialog(closedPlanApprovalTokensRef.current, currentPlanApprovalRequestRef.current?.dialogToken);
    sendBridgeEvent('plan_approval_response', payload);
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  // The backend already resolved this request; closing its dialog must not send another rejection.
  const forceCloseAskUserQuestionDialog = useCallback((requestId?: string | null, dialogToken?: string) => {
    applyForceClose(
      requestId && requestId.length > 0 ? requestId : null,
      dialogToken,
      'askUserQuestion',
      closedAskUserQuestionTokensRef.current,
      currentAskUserQuestionRequestRef,
      pendingAskUserQuestionRequestsRef,
      (item) => item.requestId,
      () => {
        currentAskUserQuestionRequestRef.current = null;
        setAskUserQuestionDialogOpen(false);
        setCurrentAskUserQuestionRequest(null);
      },
    );
  }, []);

  const forceClosePermissionDialog = useCallback((channelId?: string | null, dialogToken?: string) => {
    applyForceClose(
      channelId && channelId.length > 0 ? channelId : null,
      dialogToken,
      'permission',
      closedPermissionTokensRef.current,
      currentPermissionRequestRef,
      pendingPermissionRequestsRef,
      (item) => item.channelId,
      () => {
        currentPermissionRequestRef.current = null;
        setPermissionDialogOpen(false);
        setCurrentPermissionRequest(null);
      },
    );
  }, []);

  const forceClosePlanApprovalDialog = useCallback((requestId?: string | null, dialogToken?: string) => {
    applyForceClose(
      requestId && requestId.length > 0 ? requestId : null,
      dialogToken,
      'planApproval',
      closedPlanApprovalTokensRef.current,
      currentPlanApprovalRequestRef,
      pendingPlanApprovalRequestsRef,
      (item) => item.requestId,
      () => {
        currentPlanApprovalRequestRef.current = null;
        setPlanApprovalDialogOpen(false);
        setCurrentPlanApprovalRequest(null);
      },
    );
  }, []);

  // Context usage dialog handlers
  const isCurrentContextUsageRequest = useCallback((requestId?: string | null) => {
    if (requestId == null || requestId === '') {
      return true;
    }
    return contextUsageRequestIdRef.current === requestId;
  }, []);

  const openContextUsageDialog = useCallback((requestId?: string | null, loading = true) => {
    contextUsageRequestIdRef.current = requestId ?? null;
    setContextUsageData(null);
    setContextUsageIsLoading(loading);
    setContextUsageDialogOpen(true);
  }, []);

  const updateContextUsageData = useCallback((requestId: string | null | undefined, data: ContextUsageData) => {
    if (!isCurrentContextUsageRequest(requestId)) {
      return false;
    }
    setContextUsageIsLoading(false);
    setContextUsageData(data);
    return true;
  }, [isCurrentContextUsageRequest]);

  const closeContextUsageDialog = useCallback((requestId?: string | null) => {
    if (!isCurrentContextUsageRequest(requestId)) {
      return false;
    }
    contextUsageRequestIdRef.current = null;
    setContextUsageDialogOpen(false);
    setContextUsageIsLoading(false);
    setContextUsageData(null);
    return true;
  }, [isCurrentContextUsageRequest]);

  return {
    // Permission dialog
    permissionDialogOpen,
    currentPermissionRequest,
    openPermissionDialog,
    handlePermissionApprove,
    handlePermissionApproveAlways,
    handlePermissionSkip,
    handlePermissionCancel,
    handlePermissionDecision,
    forceClosePermissionDialog,

    // AskUserQuestion dialog
    askUserQuestionDialogOpen,
    currentAskUserQuestionRequest,
    openAskUserQuestionDialog,
    handleAskUserQuestionSubmit,
    handleAskUserQuestionCancel,
    forceCloseAskUserQuestionDialog,

    // PlanApproval dialog
    planApprovalDialogOpen,
    currentPlanApprovalRequest,
    openPlanApprovalDialog,
    handlePlanApprovalApprove,
    handlePlanApprovalReject,
    forceClosePlanApprovalDialog,

    // Rewind dialog
    rewindDialogOpen,
    setRewindDialogOpen,
    currentRewindRequest,
    setCurrentRewindRequest,
    isRewinding,
    setIsRewinding,

    // Rewind select dialog
    rewindSelectDialogOpen,
    setRewindSelectDialogOpen,

    // Context usage dialog
    contextUsageDialogOpen,
    contextUsageIsLoading,
    contextUsageData,
    openContextUsageDialog,
    updateContextUsageData,
    closeContextUsageDialog,
  };
}
