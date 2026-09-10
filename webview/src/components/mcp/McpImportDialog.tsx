import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpImportPreviewResponse, McpServer } from '../../types/mcp';
import { sendToJava } from '../../utils/bridge';

interface McpImportDialogProps {
  currentProvider?: 'claude' | 'codex' | string;
  existingIds?: string[];
  onClose: () => void;
  onImport: (servers: McpServer[]) => void;
}

interface PreviewItem {
  server: McpServer;
  originalId: string;
  finalId: string;
  renamed: boolean;
}

/**
 * Picks an id that does not collide with existing servers or ids already claimed in this batch.
 */
function uniqueId(baseId: string, taken: Set<string>): string {
  if (!taken.has(baseId)) {
    return baseId;
  }
  let counter = 2;
  while (taken.has(`${baseId}-${counter}`)) {
    counter++;
  }
  return `${baseId}-${counter}`;
}

/**
 * Import MCP servers from a GitHub Copilot configuration (root key `servers`).
 * The Java backend does the format mapping; this dialog only pastes, previews and saves.
 */
const EMPTY_EXISTING_IDS: string[] = [];

export function McpImportDialog({ currentProvider = 'claude', existingIds = EMPTY_EXISTING_IDS, onClose, onImport }: McpImportDialogProps) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  const [jsonContent, setJsonContent] = useState('');
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const buildPreview = useCallback((servers: McpServer[]): PreviewItem[] => {
    const taken = new Set<string>(existingIds);
    return servers.map(server => {
      const originalId = server.id;
      const finalId = uniqueId(originalId, taken);
      taken.add(finalId);
      return { server, originalId, finalId, renamed: finalId !== originalId };
    });
  }, [existingIds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previousHandler = window.updateCopilotImportPreview;
    window.updateCopilotImportPreview = (json: string) => {
      setLoading(false);
      try {
        const response = JSON.parse(json) as McpImportPreviewResponse;
        if (response.error) {
          setError(response.error);
          setPreview([]);
          return;
        }
        setError(null);
        setPreview(buildPreview(response.servers || []));
      } catch (parseError) {
        setError(String(parseError));
        setPreview([]);
      }
    };
    return () => {
      window.updateCopilotImportPreview = previousHandler;
    };
  }, [buildPreview]);

  const handlePreview = useCallback(() => {
    if (!jsonContent.trim()) {
      return;
    }
    setLoading(true);
    setError(null);
    sendToJava('parse_copilot_mcp_config', { json: jsonContent, isCodexMode });
  }, [jsonContent, isCodexMode]);

  const handleContentChange = (value: string) => {
    setJsonContent(value);
    // The previous preview no longer matches the edited input.
    setPreview([]);
    setError(null);
  };

  const handleConfirm = () => {
    if (preview.length === 0) {
      return;
    }
    onImport(preview.map(item => ({ ...item.server, id: item.finalId })));
    onClose();
  };

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const renamedCount = useMemo(() => preview.filter(item => item.renamed).length, [preview]);

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-import-dialog">
        <div className="dialog-header">
          <div>
            <h3>{t('mcp.import.title')}</h3>
            <div className="mcp-import-subtitle">{t('mcp.import.description')}</div>
          </div>
          <button className="close-btn" type="button" aria-label={t('mcp.cancel')} onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body mcp-import-body">
          <textarea
            className="mcp-import-textarea"
            value={jsonContent}
            placeholder={t('mcp.import.placeholder')}
            spellCheck={false}
            onChange={event => handleContentChange(event.target.value)}
          />

          <div className="mcp-import-actions-row">
            <button className="btn btn-secondary" onClick={handlePreview} disabled={!jsonContent.trim() || loading}>
              <span className={`codicon codicon-eye ${loading ? 'spinning' : ''}`}></span>
              {t('mcp.import.previewButton')}
            </button>
            {renamedCount > 0 && (
              <span className="mcp-import-rename-hint">
                <span className="codicon codicon-info"></span>
                {t('mcp.import.renameSummary', { count: renamedCount })}
              </span>
            )}
          </div>

          {error && (
            <div className="mcp-import-error">
              <span className="codicon codicon-warning"></span>
              {error}
            </div>
          )}

          <div className="mcp-import-preview">
            {preview.length === 0 && !error ? (
              <div className="mcp-import-empty">{t('mcp.import.empty')}</div>
            ) : (
              <>
                {preview.length > 0 && <div className="mcp-import-preview-title">{t('mcp.import.previewTitle')}</div>}
                {preview.map(item => (
                  <div key={item.finalId} className="mcp-import-item">
                    <div className="mcp-import-item-icon">{(item.server.name || item.finalId).charAt(0).toUpperCase()}</div>
                    <div className="mcp-import-item-info">
                      <div className="mcp-import-item-title-row">
                        <span className="mcp-import-item-name">{item.server.name || item.finalId}</span>
                        <span className="mcp-import-type-badge">{item.server.server?.type || 'stdio'}</span>
                        {item.renamed && (
                          <span className="mcp-import-renamed">{t('mcp.import.renamedFrom', { id: item.originalId })}</span>
                        )}
                      </div>
                      <div className="mcp-import-item-id">{item.finalId}</div>
                      {/* Full spec so env/headers are visible before the user confirms the import. */}
                      <pre className="mcp-import-item-spec">{JSON.stringify(item.server.server, null, 2)}</pre>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="dialog-footer mcp-import-footer">
          <div className="footer-hint">
            <span className="codicon codicon-shield"></span>
            {t('mcp.import.footerHint')}
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>{t('mcp.cancel')}</button>
            <button className="btn btn-primary" onClick={handleConfirm} disabled={preview.length === 0}>
              {t('mcp.import.confirm', { count: preview.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
