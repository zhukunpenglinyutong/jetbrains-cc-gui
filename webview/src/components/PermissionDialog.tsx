import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../utils/helpers';
import { useDialogCountdownTimeout } from '../hooks/useDialogCountdownTimeout';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import MarkdownBlock from './MarkdownBlock';
import { useDialogResize } from '../hooks/useDialogResize';
import { isEditableEventTarget } from '../utils/isEditableEventTarget';
import { clearDialogDraft, readDialogDraft, writeDialogDraft } from '../utils/dialogStateStorage';

export interface PermissionRequest {
  channelId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  suggestions?: unknown;
  deadlineMs?: number;
  dialogToken?: string;
  /** Opaque key for a native Codex server request. */
  codexInteractionKey?: string;
  /** Native method retained so the response adapter can preserve its union. */
  codexMethod?: string;
  provider?: 'claude' | 'codex' | string;
}

type NativeDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  | 'acceptWithExecpolicyAmendment' | 'applyNetworkPolicyAmendment';

function readNativeDecisions(suggestions: unknown): NativeDecision[] | null {
  if (!Array.isArray(suggestions)) return null;
  const decisions = suggestions.flatMap((entry): NativeDecision[] => {
    const value = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.keys(entry as Record<string, unknown>)[0]
        : '';
    return ['accept', 'acceptForSession', 'decline', 'cancel',
      'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'].includes(value)
      ? [value as NativeDecision]
      : [];
  });
  return decisions.length > 0 ? Array.from(new Set(decisions)) : [];
}

interface PermissionDialogProps {
  isOpen: boolean;
  request: PermissionRequest | null;
  onApprove: (channelId: string) => void | boolean;
  onSkip: (channelId: string) => void | boolean;
  onApproveAlways: (channelId: string) => void | boolean;
  onCancel?: (channelId: string) => void | boolean;
  onDecision?: (channelId: string, decision: Record<string, unknown>) => void | boolean;
  timeoutSeconds?: number;
}

interface PermissionDialogDraft {
  deadlineMs?: number;
  dialogToken?: string;
  showCommand?: boolean;
  selectedIndex?: number;
}

// Format a single tool-input value for display. Pure helper hoisted to module
// scope so it is not recreated on every render (the dialog re-renders once per
// second while the timeout countdown ticks).
const formatInputValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        const text = formatInputValue(item);
        return text ? [text] : [];
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (typeof record.content === 'string') {
      return record.content;
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};

// Derive the primary command / action content from the tool inputs.
const getCommandContent = (inputs: Record<string, unknown>): string => {
  // Get primary content based on tool type
  if ('command' in inputs && inputs.command !== undefined) {
    return formatInputValue(inputs.command);
  }
  if ('content' in inputs && inputs.content !== undefined) {
    return formatInputValue(inputs.content);
  }
  if ('text' in inputs && inputs.text !== undefined) {
    return formatInputValue(inputs.text);
  }
  // For other tools, format all inputs (skip internal policy fields)
  const lines: string[] = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (!key.startsWith('_')) {
      lines.push(`${key}: ${formatInputValue(value)}`);
    }
  }
  return lines.join('\n');
};

// Derive the working-directory / path label from the tool inputs.
const getWorkingDirectory = (inputs: Record<string, unknown>): string => {
  if (typeof inputs.cwd === 'string' && inputs.cwd) {
    return inputs.cwd;
  }
  if (typeof inputs.file_path === 'string' && inputs.file_path) {
    return inputs.file_path;
  }
  if (typeof inputs.path === 'string' && inputs.path) {
    return inputs.path;
  }
  return '~';
};

function getProposedChanges(inputs: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = inputs.proposedChanges ?? inputs.proposed_changes
    ?? inputs.changes ?? inputs.fileChanges ?? inputs.files;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([path, change]) => ({
      path,
      ...(change && typeof change === 'object' && !Array.isArray(change)
        ? change as Record<string, unknown>
        : { value: change }),
    }));
  }
  return [];
}

function getRequestedPermissions(inputs: Record<string, unknown>): Record<string, unknown> | null {
  const value = inputs.permissions ?? inputs.additionalPermissions
    ?? inputs.additional_permissions ?? inputs.requestedPermissions;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const PermissionDialog = ({
  isOpen,
  request,
  onApprove,
  onSkip,
  onApproveAlways,
  onCancel,
  onDecision,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}: PermissionDialogProps) => {
  const [showCommand, setShowCommand] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hydratedRequestKey, setHydratedRequestKey] = useState<string | null>(null);
  const { t } = useTranslation();
  const { dialogRef, dialogHeight, setDialogHeight, handleResizeStart } = useDialogResize({ minHeight: 150 });
  const nativeDecisions = useMemo(
    () => (request?.provider === 'codex' ? readNativeDecisions(request.suggestions) : null),
    [request],
  );
  const nativeDecisionPayloads = useMemo(() => {
    if (!Array.isArray(request?.suggestions)) return [];
    return request.suggestions.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const kind = Object.keys(record)[0] as NativeDecision | undefined;
      return kind && (kind === 'acceptWithExecpolicyAmendment' || kind === 'applyNetworkPolicyAmendment')
        ? [{ kind, decision: { [kind]: record[kind] } }]
        : [];
    });
  }, [request]);
  const isFileApproval = request?.provider === 'codex'
    && request.codexMethod === 'item/fileChange/requestApproval';
  const proposedChanges = useMemo(
    () => request ? getProposedChanges(request.inputs) : [],
    [request],
  );
  const requestedPermissions = useMemo(
    () => request?.codexMethod === 'item/permissions/requestApproval'
      ? getRequestedPermissions(request.inputs)
      : null,
    [request],
  );
  const previewUnavailable = isFileApproval && proposedChanges.length === 0;
  const permissionOptions = useMemo(() => {
    const allowsApprove = !previewUnavailable
      && (nativeDecisions === null || nativeDecisions.includes('accept'));
    const allowsSession = !previewUnavailable
      && (nativeDecisions === null || nativeDecisions.includes('acceptForSession'));
    const options: Array<{
      action: 'approve' | 'always' | 'skip' | 'cancel' | 'native';
      label: string;
      decision?: Record<string, unknown>;
    }> = [
      ...(allowsApprove ? [{ action: 'approve' as const, label: t('permission.allow') }] : []),
    ];
    if (allowsSession) options.push({ action: 'always', label: t('permission.allowAlways') });
    const declineLabel = t('permission.deny');
    // Keep a safe way out even when a native advertisement omits decline. The
    // browser must not leave the user trapped in a request whose native list is
    // incomplete or forward-versioned; the backend validates the typed result.
    options.push({ action: 'skip', label: declineLabel });
    if (nativeDecisions?.includes('cancel')) {
      options.push({ action: 'cancel', label: t('common.cancel', 'Cancel') });
    }
    for (const suggestion of nativeDecisionPayloads) {
      options.push({
        action: 'native',
        decision: suggestion.decision,
        label: suggestion.kind === 'acceptWithExecpolicyAmendment'
          ? t('permission.allowWithRule', 'Allow with this command rule')
          : t('permission.allowWithNetworkRule', 'Allow with this network rule'),
      });
    }
    return options;
  }, [nativeDecisionPayloads, nativeDecisions, previewUnavailable, t]);

  const handleTimeout = useCallback(() => {
    if (request) {
      clearDialogDraft('permission', request.channelId, request.dialogToken);
      if (nativeDecisions?.includes('cancel')) {
        onCancel?.(request.channelId);
      } else {
        onSkip(request.channelId);
      }
    }
  }, [nativeDecisions, onCancel, onSkip, request]);

  const { remainingSeconds, isTimeWarning, markSubmitted, restoreSubmission } = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.dialogToken ?? request?.channelId,
    timeoutSeconds,
    deadlineMs: request?.deadlineMs,
    onTimeout: handleTimeout,
  });

  const handleApprove = useCallback(() => {
    if (!request || !markSubmitted()) return;
    if (onApprove(request.channelId) === false) restoreSubmission();
    else clearDialogDraft('permission', request.channelId, request.dialogToken);
  }, [request, markSubmitted, restoreSubmission, onApprove]);

  const handleApproveAlways = useCallback(() => {
    if (!request || !markSubmitted()) return;
    if (onApproveAlways(request.channelId) === false) restoreSubmission();
    else clearDialogDraft('permission', request.channelId, request.dialogToken);
  }, [request, markSubmitted, restoreSubmission, onApproveAlways]);

  const handleSkip = useCallback(() => {
    if (!request || !markSubmitted()) return;
    if (onSkip(request.channelId) === false) restoreSubmission();
    else clearDialogDraft('permission', request.channelId, request.dialogToken);
  }, [request, markSubmitted, restoreSubmission, onSkip]);

  const handleCancel = useCallback(() => {
    if (!request || !markSubmitted()) return;
    if ((onCancel ?? onSkip)(request.channelId) === false) restoreSubmission();
    else clearDialogDraft('permission', request.channelId, request.dialogToken);
  }, [markSubmitted, restoreSubmission, onCancel, onSkip, request]);

  const handleNativeDecision = useCallback((decision: Record<string, unknown>) => {
    if (!request || !markSubmitted()) return;
    const sent = onDecision ? onDecision(request.channelId, decision) : onApprove(request.channelId);
    if (sent === false) restoreSubmission();
    else clearDialogDraft('permission', request.channelId, request.dialogToken);
  }, [markSubmitted, restoreSubmission, onApprove, onDecision, request]);

  // Hydrate draft state exactly once per request via render-time adjustment:
  // the key is derived during render and the previous-key state tracks which
  // request has already been hydrated (no effect chain, no extra commit).
  const requestKey = isOpen && request ? request.dialogToken ?? request.channelId : null;
  if (hydratedRequestKey !== requestKey) {
    setHydratedRequestKey(requestKey);
    if (requestKey !== null && request) {
      const draft = readDialogDraft<PermissionDialogDraft>('permission', request.channelId, request.deadlineMs, request.dialogToken);
      const restoredIndex = draft?.selectedIndex;
      setShowCommand(draft?.showCommand !== false);
      setSelectedIndex(
        typeof restoredIndex === 'number' && Number.isInteger(restoredIndex)
          ? Math.max(0, Math.min(permissionOptions.length - 1, restoredIndex))
          : 0,
      );
      setDialogHeight(null);
    }
  }

  useEffect(() => {
    const channelId = request?.channelId;
    const deadlineMs = request?.deadlineMs;
    if (!isOpen || channelId === undefined) {
      return;
    }
    writeDialogDraft('permission', channelId, {
      deadlineMs,
      dialogToken: request?.dialogToken,
      showCommand,
      selectedIndex,
    });
  }, [isOpen, request?.channelId, request?.dialogToken, request?.deadlineMs, selectedIndex, showCommand]);

  // Latest-handler ref: the keydown subscription stays stable across
  // selectedIndex/callback changes instead of re-subscribing every render.
  const keydownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keydownHandlerRef.current = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) {
        return;
      }

      if (/^[1-9]$/.test(e.key)) {
        const option = permissionOptions[Number(e.key) - 1];
        if (option?.action === 'approve') handleApprove();
        else if (option?.action === 'always') handleApproveAlways();
        else if (option?.action === 'skip') handleSkip();
        else if (option?.action === 'cancel') handleCancel();
        else if (option?.action === 'native' && option.decision) handleNativeDecision(option.decision);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(permissionOptions.length - 1, prev + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const option = permissionOptions[selectedIndex];
        if (option?.action === 'approve') handleApprove();
        else if (option?.action === 'always') handleApproveAlways();
        else if (option?.action === 'skip') handleSkip();
        else if (option?.action === 'cancel') {
          handleCancel();
        }
        else if (option?.action === 'native' && option.decision) {
          handleNativeDecision(option.decision);
        }
      }
    };
  });

  useEffect(() => {
    if (!isOpen || !request) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => keydownHandlerRef.current(e);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request]);

  // Derived display values are memoized so the per-second countdown re-render
  // does not re-run command formatting (which may JSON.stringify inputs).
  // Hooks must run before the early return below, hence the null guard.
  const commandContent = useMemo(
    () => (request ? getCommandContent(request.inputs) : ''),
    [request],
  );
  const workingDirectory = useMemo(
    () => (request ? getWorkingDirectory(request.inputs) : '~'),
    [request],
  );

  if (!isOpen || !request) {
    return null;
  }

  // Map tool name to display title
  const getToolTitle = (toolName: string): string => {
    const key = `permission.tools.${toolName}`;
    const translated = t(key);
    // If translation key does not exist, return default template
    if (translated === key) {
      return t('permission.tools.execute', { toolName });
    }
    return translated;
  };

  return (
    <div className="permission-dialog-overlay">
      <div
        ref={dialogRef}
        className="permission-dialog-v3"
        style={dialogHeight ? { height: dialogHeight, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const } : undefined}
      >
        <div className="permission-dialog-v3-resize-handle" onPointerDown={handleResizeStart} />
        <div className="permission-dialog-v3-header-row">
          <h3 className="permission-dialog-v3-title">{getToolTitle(request.toolName)}</h3>
          <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
            <span className="codicon codicon-clock" />
            <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
          </span>
        </div>
        {isTimeWarning && (
          <div className="timeout-warning-banner">
            <span className="codicon codicon-warning" />
            <span>{t('permission.timeoutWarning', 'Please answer soon, dialog will close in {{seconds}} seconds', { seconds: remainingSeconds })}</span>
          </div>
        )}
        <p className="permission-dialog-v3-subtitle">{t('permission.fromExternalProcess')}</p>

        <div className="permission-dialog-v3-command-box">
          <div className="permission-dialog-v3-command-header">
            <span className="command-path">
              <span className="command-arrow">→</span> ~ {workingDirectory}
            </span>
            <button
              className="command-toggle"
              onClick={() => setShowCommand(!showCommand)}
              title={showCommand ? t('chat.collapse') : t('chat.expand')}
            >
              <span className={`codicon codicon-chevron-${showCommand ? 'up' : 'down'}`} />
            </button>
          </div>

          {showCommand && (
            <div
              className="permission-dialog-v3-command-content"
              style={dialogHeight ? { maxHeight: 'none' } : undefined}
            >
              <MarkdownBlock content={commandContent} isStreaming={false} />
            </div>
          )}
        </div>

        {isFileApproval && (
          <div className="permission-dialog-v3-preview" data-testid="codex-file-preview">
            {previewUnavailable ? (
              <p>{t('permission.previewUnavailable', 'Native file preview is unavailable. You can deny or cancel this request.')}</p>
            ) : (
              <ul>
                {proposedChanges.map((change, index) => {
                  const path = String(change.path ?? change.filePath ?? change.filename ?? `change-${index + 1}`);
                  const nativeKind = change.kind && typeof change.kind === 'object'
                    ? change.kind as Record<string, unknown> : null;
                  const kind = String(nativeKind?.type ?? change.kind ?? change.status ?? change.action ?? 'change');
                  const movePath = nativeKind?.movePath ?? change.newPath;
                  return <li key={`${path}-${index}`}><strong>{kind}</strong> {path}
                    {typeof movePath === 'string' && movePath ? ` → ${movePath}` : ''}</li>;
                })}
              </ul>
            )}
          </div>
        )}

        {requestedPermissions && (
          <div className="permission-dialog-v3-preview" data-testid="codex-permission-scope">
            <strong>{t('permission.requestedPermissions', 'Requested native permissions')}</strong>
            <pre>{JSON.stringify(requestedPermissions, null, 2)}</pre>
          </div>
        )}

        {/* Option buttons list */}
        <div className="permission-dialog-v3-options">
          {permissionOptions.map((option, index) => {
            const onClick = option.action === 'approve'
              ? handleApprove
              : option.action === 'always'
                ? handleApproveAlways
                : option.action === 'skip'
                  ? handleSkip
                  : option.action === 'cancel'
                    ? handleCancel
                    : () => option.decision && handleNativeDecision(option.decision);
            return (
              <button
                key={`${option.action}-${index}`}
                className={`permission-dialog-v3-option ${selectedIndex === index ? 'selected' : ''}`}
                onClick={onClick}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="option-text">{option.label}</span>
                <span className="option-key">{index + 1}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;
