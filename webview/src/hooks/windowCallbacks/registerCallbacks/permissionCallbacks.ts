import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { sendBridgeEvent } from '../../../utils/bridge';
import type { AskUserQuestionRequest, Question } from '../../../components/AskUserQuestionDialog';

type PermissionCallbacks = Pick<UseWindowCallbacksOptions,
  | 'openPermissionDialog' | 'openAskUserQuestionDialog' | 'openPlanApprovalDialog'
  | 'forceClosePermissionDialog' | 'forceCloseAskUserQuestionDialog' | 'forceClosePlanApprovalDialog'
  | 'addToast' | 'currentProviderRef' | 'currentSessionIdRef'
>;

interface CodexRuntimeEnvelope {
  kind?: string;
  channelId?: string;
  threadId?: string | null;
  rootThreadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  interactionKey?: string;
  dialogToken?: string;
  deliverySequence?: number;
  resolved?: boolean;
  payload?: {
    method?: string;
    params?: Record<string, unknown>;
    threadName?: string | null;
    message?: string;
    willRetry?: boolean;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Build the typed decision suggestions a Codex approval dialog may offer.
 *
 * The app-server does not send an `availableDecisions` list; it proposes
 * amendments through `proposedExecpolicyAmendment` (string[]) and
 * `proposedNetworkPolicyAmendments` ({host, action}[]) on the approval
 * params. Those become extra "allow with rule" options on top of the
 * standard accept/acceptForSession/decline decisions. Returns undefined when
 * there is nothing to advertise so the dialog keeps its default options.
 */
function buildCodexApprovalSuggestions(params: Record<string, unknown>): unknown[] | undefined {
  const suggestions: unknown[] = [];
  const advertised = params.availableDecisions ?? params.available_decisions;
  if (Array.isArray(advertised)) {
    suggestions.push(...advertised);
  } else {
    suggestions.push('accept', 'acceptForSession', 'decline');
  }
  const execpolicyAmendment = params.proposedExecpolicyAmendment;
  if (Array.isArray(execpolicyAmendment) && execpolicyAmendment.length > 0
      && execpolicyAmendment.every((entry) => typeof entry === 'string')) {
    suggestions.push({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: execpolicyAmendment },
    });
  }
  const networkAmendments = params.proposedNetworkPolicyAmendments;
  if (Array.isArray(networkAmendments)) {
    for (const entry of networkAmendments) {
      const rule = asRecord(entry);
      if (rule && typeof rule.host === 'string'
          && (rule.action === 'allow' || rule.action === 'deny')) {
        suggestions.push({
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: rule.host, action: rule.action },
          },
        });
      }
    }
  }
  return suggestions.length > 0 ? suggestions : undefined;
}

function schemaQuestions(
  request: Record<string, unknown>,
  serverName: string | undefined,
): Question[] {
  const schema = asRecord(request.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (!schema || !properties) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
  const message = typeof request.message === 'string' ? request.message : 'MCP server is requesting information';
  return Object.entries(properties).flatMap(([id, rawSchema]) => {
    const field = asRecord(rawSchema);
    if (!field) return [];
    const enumValues = Array.isArray(field.enum)
      ? field.enum.filter((value): value is string => typeof value === 'string')
      : [];
    const itemEnum = asRecord(field.items)?.enum;
    const arrayEnum = Array.isArray(itemEnum)
      ? itemEnum.filter((value): value is string => typeof value === 'string')
      : [];
    const values = enumValues.length > 0 ? enumValues : arrayEnum;
    const type = typeof field.type === 'string' ? field.type : 'string';
    const title = typeof field.title === 'string' ? field.title : id;
    const description = typeof field.description === 'string' ? field.description : '';
    return [{
      id,
      question: description || (Object.keys(properties).length === 1 ? message : title),
      header: serverName ? `${serverName}: ${title}` : title,
      options: values.map((value) => ({ label: value, description: '' })),
      multiSelect: type === 'array',
      required: required.has(id),
      isSecret: field.isSecret === true || field.writeOnly === true || field.format === 'password',
    }];
  });
}

function buildMcpQuestionRequest(
  event: CodexRuntimeEnvelope,
  method: string,
  params: Record<string, unknown>,
): AskUserQuestionRequest {
  const nativeRequest = asRecord(params.request) ?? params;
  const mode = typeof nativeRequest.mode === 'string' ? nativeRequest.mode : 'unsupported';
  const serverName = typeof params.serverName === 'string' ? params.serverName : undefined;
  const requestedSchema = asRecord(nativeRequest.requestedSchema) ?? undefined;
  const meta = nativeRequest._meta;
  const url = typeof nativeRequest.url === 'string' ? nativeRequest.url : undefined;
  let questions = mode === 'form'
    ? schemaQuestions(nativeRequest, serverName)
    : [];
  if (mode === 'url') {
    questions = [{
      id: '__codex_url__',
      question: typeof nativeRequest.message === 'string' ? nativeRequest.message : 'Open the MCP authorization URL?',
      header: serverName ?? 'MCP server',
      options: [{ label: 'Open URL', description: url ?? '' }],
      multiSelect: false,
      required: true,
    }];
  }
  if (mode === 'userVerification') {
    questions = [{
      id: '__codex_user_verification__',
      question: typeof nativeRequest.message === 'string'
        ? nativeRequest.message
        : 'Do you want to continue with this MCP request?',
      header: serverName ?? 'MCP server',
      options: [
        { label: 'Confirm', description: 'Continue with the MCP request.' },
        { label: 'Cancel', description: 'Decline the MCP request.' },
      ],
      multiSelect: false,
      required: true,
    }];
  }
  return {
    requestId: event.interactionKey ?? '',
    toolName: method,
    questions,
    provider: 'codex',
    isBlocking: params.isBlocking !== false,
    deadlineMs: typeof params.deadlineAt === 'number' ? params.deadlineAt : undefined,
    dialogToken: event.dialogToken,
    codexInteractionKey: event.interactionKey,
    codexMethod: method,
    codexElicitation: {
      mode: mode === 'form' || mode === 'url' || mode === 'userVerification' ? mode : 'unsupported',
      serverName,
      url,
      requestedSchema,
      meta,
    },
  };
}

export function registerPermissionCallbacks(options: PermissionCallbacks): void {
  const {
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
  } = options;

  window.showPermissionDialog = (json) => {
    try {
      openPermissionDialog(JSON.parse(json));
    } catch (error) {
      console.error('[Frontend] Failed to parse permission request:', error);
    }
  };
  window.showAskUserQuestionDialog = (json) => {
    try {
      openAskUserQuestionDialog(JSON.parse(json));
    } catch (error) {
      console.error('[Frontend] Failed to parse ask user question request:', error);
    }
  };
  window.showPlanApprovalDialog = (json) => {
    try {
      openPlanApprovalDialog(JSON.parse(json));
    } catch (error) {
      console.error('[Frontend] Failed to parse plan approval request:', error);
    }
  };

  const acknowledgeClose = (functionName: string, targetId: string | null, dialogToken?: string) => {
    if (!dialogToken) return;
    // Placeholders only buffer signals; acknowledging before consumption would lose closes on reload.
    sendBridgeEvent('dialog_delivery_ack', JSON.stringify({ functionName, targetId, dialogToken }));
  };
  window.forceClosePermissionDialog = (targetId, dialogToken) => {
    forceClosePermissionDialog(targetId ?? null, dialogToken);
    acknowledgeClose('forceClosePermissionDialog', targetId ?? null, dialogToken);
  };
  window.forceCloseAskUserQuestionDialog = (targetId, dialogToken) => {
    forceCloseAskUserQuestionDialog(targetId ?? null, dialogToken);
    acknowledgeClose('forceCloseAskUserQuestionDialog', targetId ?? null, dialogToken);
  };
  window.forceClosePlanApprovalDialog = (targetId, dialogToken) => {
    forceClosePlanApprovalDialog(targetId ?? null, dialogToken);
    acknowledgeClose('forceClosePlanApprovalDialog', targetId ?? null, dialogToken);
  };

  window.onCodexRuntimeEvent = (json) => {
    try {
      const event = JSON.parse(json) as CodexRuntimeEnvelope;
      window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: event }));
      if (event.kind === 'nativeWarning') {
        const currentThread = options.currentSessionIdRef.current;
        const warningRoot = event.rootThreadId ?? event.threadId;
        if (options.currentProviderRef.current === 'codex' && (!currentThread || warningRoot === currentThread)
            && event.payload?.message) {
          options.addToast(event.payload.message, 'warning');
        }
        return;
      }
      if (event.kind === 'threadNameUpdated' && event.threadId && event.payload?.threadName) {
        window.updateSessionTitle?.(event.threadId, event.payload.threadName);
        return;
      }
      const acknowledgeCodexDelivery = (phase: 'show' | 'close') => {
        if (!event.interactionKey || !event.dialogToken || typeof event.deliverySequence !== 'number') {
          return;
        }
        sendBridgeEvent('codex_interaction_delivery_ack', JSON.stringify({
          interactionKey: event.interactionKey,
          dialogToken: event.dialogToken,
          deliverySequence: event.deliverySequence,
          phase,
        }));
      };
      if (event.resolved && event.interactionKey) {
        const method = event.payload?.method ?? '';
        if (method.includes('requestUserInput') || method.includes('elicitation')) {
          forceCloseAskUserQuestionDialog(
            event.interactionKey,
            event.dialogToken ?? `${event.interactionKey}:${event.deliverySequence ?? 0}`,
          );
        } else {
          forceClosePermissionDialog(
            event.channelId ?? event.interactionKey,
            event.dialogToken ?? `${event.interactionKey}:${event.deliverySequence ?? 0}`,
          );
        }
        acknowledgeCodexDelivery('close');
        return;
      }
      if (event.kind !== 'interactionRequested' || event.resolved || !event.interactionKey) return;
      const method = event.payload?.method ?? '';
      const params = event.payload?.params ?? {};
      const deadlineAt = typeof params.deadlineAt === 'number' ? params.deadlineAt : undefined;
      const dialogToken = event.dialogToken ?? `${event.interactionKey}:${event.deliverySequence ?? 0}`;
      if (method === 'mcpServer/elicitation/request') {
        openAskUserQuestionDialog(buildMcpQuestionRequest(event, method, params));
        acknowledgeCodexDelivery('show');
        return;
      }
      if (method.includes('requestUserInput')) {
        const questions = Array.isArray(params.questions)
          ? params.questions
          : params.form && typeof params.form === 'object'
            ? [params.form]
            : [];
        openAskUserQuestionDialog({
          requestId: event.interactionKey,
          toolName: method,
          questions: questions as never,
          provider: 'codex',
          isBlocking: params.isBlocking !== false,
          deadlineMs: deadlineAt,
          dialogToken,
          codexInteractionKey: event.interactionKey,
          codexMethod: method,
        });
        acknowledgeCodexDelivery('show');
        return;
      }
      openPermissionDialog({
        channelId: event.channelId ?? event.interactionKey,
        toolName: method || 'Codex approval',
        inputs: params,
        suggestions: buildCodexApprovalSuggestions(params),
        deadlineMs: deadlineAt,
        dialogToken,
        codexInteractionKey: event.interactionKey,
        codexMethod: method,
        provider: 'codex',
      });
      acknowledgeCodexDelivery('show');
    } catch (error) {
      console.error('[Frontend] Failed to route Codex runtime event:', error);
    }
  };

  const pendingNativeEvents = window.__pendingCodexRuntimeEvents ?? [];
  window.__pendingCodexRuntimeEvents = [];
  for (const event of pendingNativeEvents) {
    window.onCodexRuntimeEvent?.(event);
  }

  const callbacks = {
    permission: { show: window.showPermissionDialog, close: window.forceClosePermissionDialog },
    askUserQuestion: { show: window.showAskUserQuestionDialog, close: window.forceCloseAskUserQuestionDialog },
    planApproval: { show: window.showPlanApprovalDialog, close: window.forceClosePlanApprovalDialog },
  };
  const pending = window.__pendingDialogEvents ?? [];
  window.__pendingDialogEvents = [];
  for (const event of pending) {
    if (event.type === 'show') {
      callbacks[event.kind].show(event.payload);
    } else {
      callbacks[event.kind].close(event.targetId, event.dialogToken);
    }
  }
}
