/**
 * Server Card Header Component
 * Header row of a server card: expand toggle, icon, name, status badge,
 * edit/copy/delete action buttons, and the enable toggle switch
 */

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { McpServer, McpServerStatusInfo } from '../../types/mcp';
import { getServerInitial } from './utils';
import { ServerCardStatusBadge } from './ServerCardStatusBadge';
import { McpConfirmDialog } from './McpConfirmDialog';

/** What the pending confirmation in this card is about. */
type PendingConfirm = 'approve' | 'copy' | null;

/**
 * Human-readable description of what approving this server would let it run.
 * Everything is rendered as text by McpConfirmDialog, never as markup.
 */
export function describeServerTarget(
  server: McpServer,
  t: (key: string) => string,
): string {
  const spec = server.server ?? {};
  if (spec.command) {
    const args = Array.isArray(spec.args) ? spec.args.map((arg) => String(arg)) : [];
    return [String(spec.command), ...args].join(' ');
  }
  if (typeof spec.url === 'string' && spec.url) {
    return spec.url;
  }
  return t('mcp.approveConfirmUnknownTarget');
}

/** Warning tint for the "approval not confirmed by git" badge. */
const TRUST_UNVERIFIED_BADGE_STYLE: React.CSSProperties = {
  color: 'var(--color-warning)',
  borderColor: 'var(--color-warning)',
};

/**
 * True only when the backend explicitly reported that the approval source of this
 * server was NOT confirmed by git (the project folder is not a git repository).
 *
 * A missing `trustVerified` means an older backend that does not know about git
 * verification at all — that is a normal state, so it must stay silent. The check is
 * deliberately `=== false` rather than a `?? true` fail-open default: the field is
 * about a security-relevant guarantee, and "the backend did not say" is not evidence
 * of a verified approval, but it is also not evidence of a broken one.
 */
export function hasUnverifiedTrustSource(server: McpServer): boolean {
  return server.trustVerified === false;
}

export interface ServerCardHeaderProps {
  server: McpServer;
  isExpanded: boolean;
  enabled: boolean;
  effectiveStatus: McpServerStatusInfo['status'] | undefined;
  emptyToolsWarning: boolean;
  isCodexMode: boolean;
  isProjectLocal?: boolean;
  approvalStatus?: 'approved' | 'pending' | 'rejected';
  iconStyle: React.CSSProperties;
  statusColorStyle: React.CSSProperties;
  t: (key: string, options?: Record<string, unknown>) => string;
  onToggleExpand: () => void;
  onToggleServer: (enabled: boolean) => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onApprove?: () => void;
  onReject?: () => void;
}

/**
 * Server card header with identity, status badge, and action buttons
 */
export function ServerCardHeader({
                                   server,
                                   isExpanded,
                                   enabled,
                                   effectiveStatus,
                                   emptyToolsWarning,
                                   isCodexMode,
                                   isProjectLocal = false,
                                   approvalStatus,
                                   iconStyle,
                                   statusColorStyle,
                                   t,
                                   onToggleExpand,
                                   onToggleServer,
                                   onEdit,
                                   onCopy,
                                   onDelete,
                                   onApprove,
                                   onReject,
                                 }: ServerCardHeaderProps) {
  // Approving a project-local server grants a repository permission to run code on
  // this machine, and copying a foreign project-local config can hand the user
  // somebody else's credentials. Both are one click away, so both ask first.
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);
  const [portalReady, setPortalReady] = useState(false);

  useEffect(() => {
    setPortalReady(true);
    return () => setPortalReady(false);
  }, []);

  const serverName = server.name || server.id;
  const trustUnverified = hasUnverifiedTrustSource(server);
  const closeConfirm = () => setPendingConfirm(null);
  const confirmAndRun = () => {
    const action = pendingConfirm;
    setPendingConfirm(null);
    if (action === 'approve') {
      onApprove?.();
    } else if (action === 'copy') {
      onCopy();
    }
  };

  // The git caveat is appended as a second sentence in the same plain-text message:
  // McpConfirmDialog renders it as text, and this is exactly the moment the user is
  // about to hand a .mcp.json server the right to run code on their machine.
  const approveMessage = trustUnverified
    ? `${t('mcp.approveConfirmMessage', {
      name: serverName,
      target: describeServerTarget(server, t),
    })} ${t('mcp.trustNotGitVerifiedDialogNote')}`
    : t('mcp.approveConfirmMessage', {
      name: serverName,
      target: describeServerTarget(server, t),
    });

  // Built only while a confirmation is pending — describeServerTarget walks the
  // command line, and this header re-renders on every list update.
  const confirmDialog = !pendingConfirm ? null : pendingConfirm === 'approve' ? (
      <McpConfirmDialog
        title={t('mcp.approveConfirmTitle')}
        message={approveMessage}
        confirmText={t('mcp.approveConfirm')}
        cancelText={t('mcp.cancel')}
        onConfirm={confirmAndRun}
        onCancel={closeConfirm}
      />
    ) : (
      <McpConfirmDialog
        title={t('mcp.copyConfigWarningTitle')}
        message={t('mcp.copyConfigWarningMessage', { name: serverName })}
        confirmText={t('mcp.copyConfigWarningConfirm')}
        cancelText={t('mcp.cancel')}
        onConfirm={confirmAndRun}
        onCancel={closeConfirm}
      />
  );

  return (
      <div className="card-header" onClick={onToggleExpand}>
        <div className="header-left-section">
          <span className={`expand-icon codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
          <div className="server-icon" style={iconStyle}>
            {getServerInitial(server)}
          </div>
          <span className="server-name">{server.name || server.id}</span>
          {isProjectLocal && (
              <span className="project-local-badge" title={t('mcp.projectLocalReadOnly')}>
            <span className="codicon codicon-repo"></span> {t('mcp.projectLocal')}
          </span>
          )}
          {isProjectLocal && approvalStatus === 'pending' && (
              <span className="approval-badge pending" title={t('mcp.pendingApprovalDesc')}>
            <span className="codicon codicon-warning"></span> {t('mcp.pendingApprovalBadge')}
          </span>
          )}
          {isProjectLocal && approvalStatus === 'rejected' && (
              <span className="approval-badge rejected" title={t('mcp.rejectedDesc')}>
            <span className="codicon codicon-stop"></span> {t('mcp.rejectedBadge')}
          </span>
          )}
          {/* The approval was recorded, but git could not vouch for where it lives:
              the project folder is not a repository, so the .mcp.json trust decision
              is not provably local to this machine. Server names and tooltips are
              plain text — never markup. */}
          {trustUnverified && (
              <span
                  className="project-local-badge"
                  style={TRUST_UNVERIFIED_BADGE_STYLE}
                  title={t('mcp.trustNotGitVerifiedDesc')}
              >
            <span className="codicon codicon-git-branch"></span> {t('mcp.trustNotGitVerifiedBadge')}
          </span>
          )}
          {/* Connection status indicator */}
          <ServerCardStatusBadge
              server={server}
              effectiveStatus={effectiveStatus}
              isCodexMode={isCodexMode}
              emptyToolsWarning={emptyToolsWarning}
              statusColorStyle={statusColorStyle}
              t={t}
          />
        </div>
        <div className="header-right-section" onClick={(e) => e.stopPropagation()}>
          {/* Approve/Reject buttons for project-local servers awaiting a decision.
              A rejected server keeps the Approve button so the decision is reversible —
              otherwise rejecting would be a one-way dead end. */}
          {isProjectLocal && (approvalStatus === 'pending' || approvalStatus === 'rejected') && onApprove && (
              <button
                  className="icon-btn approve-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingConfirm('approve');
                  }}
                  title={t('mcp.approveTooltip')}
              >
                <span className="codicon codicon-check"></span>
              </button>
          )}
          {isProjectLocal && (approvalStatus === 'pending' || approvalStatus === 'approved') && onReject && (
              <button
                  className="icon-btn reject-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReject();
                  }}
                  title={t('mcp.rejectTooltip')}
              >
                <span className="codicon codicon-x"></span>
              </button>
          )}
          {/* Edit button — disabled for project-local servers (managed in .mcp.json) */}
          <button
              className="icon-btn edit-btn"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              disabled={isProjectLocal}
              title={isProjectLocal ? t('mcp.projectLocalReadOnly') : t('chat.editConfig')}
          >
            <span className="codicon codicon-edit"></span>
          </button>
          {/* Copy button — stays enabled even for project-local servers, but a
              project-local config comes from the repository and may carry its
              author's secrets, so it is confirmed first. */}
          <button
              className="icon-btn copy-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (isProjectLocal) {
                  setPendingConfirm('copy');
                } else {
                  onCopy();
                }
              }}
              title={t('chat.copyConfig')}
          >
            <span className="codicon codicon-copy"></span>
          </button>
          {/* Delete button — disabled for project-local servers (managed in .mcp.json) */}
          <button
              className="icon-btn delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              disabled={isProjectLocal}
              title={isProjectLocal ? t('mcp.projectLocalReadOnly') : t('chat.deleteServer')}
          >
            <span className="codicon codicon-trash"></span>
          </button>
          <label className="toggle-switch">
            <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  if (!isProjectLocal) onToggleServer(e.target.checked);
                }}
                disabled={isProjectLocal}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        {/* Rendered through a portal: .server-card sets overflow:hidden, so an
            in-place overlay would be clipped to the card. */}
        {portalReady && pendingConfirm && createPortal(confirmDialog, document.body)}
      </div>
  );
}