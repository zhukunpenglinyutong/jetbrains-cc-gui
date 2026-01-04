import { useTranslation } from 'react-i18next';

interface McpHelpDialogProps {
  onClose: () => void;
}

/**
 * MCP Help Information Dialog
 */
export function McpHelpDialog({ onClose }: McpHelpDialogProps) {
  const { t } = useTranslation();

  // Click overlay to close
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-help-dialog">
        <div className="dialog-header">
          <h3>{t('mcp.help.title')}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <div className="help-content">
            <section className="help-section">
              <h4>
                <span className="codicon codicon-info"></span>
                {t('mcp.help.protocol.title')}
              </h4>
              <p>
                {t('mcp.help.protocol.description')}
              </p>
            </section>

            <section className="help-section">
              <h4>
                <span className="codicon codicon-rocket"></span>
                {t('mcp.help.features.title')}
              </h4>
              <ul>
                <li><strong>{t('mcp.help.features.toolExtension.label')}</strong>：{t('mcp.help.features.toolExtension.description')}</li>
                <li><strong>{t('mcp.help.features.dataConnection.label')}</strong>：{t('mcp.help.features.dataConnection.description')}</li>
                <li><strong>{t('mcp.help.features.security.label')}</strong>：{t('mcp.help.features.security.description')}</li>
                <li><strong>{t('mcp.help.features.integration.label')}</strong>：{t('mcp.help.features.integration.description')}</li>
              </ul>
            </section>

            <section className="help-section">
              <h4>
                <span className="codicon codicon-book"></span>
                {t('mcp.help.configuration.title')}
              </h4>
              <p>{t('mcp.help.configuration.description')}</p>
              <ul>
                <li>
                  <strong>STDIO</strong>：{t('mcp.help.configuration.stdio.description')}
                  <code className="inline-code">{t('mcp.help.configuration.stdio.example')}</code>
                </li>
                <li>
                  <strong>HTTP/SSE</strong>：{t('mcp.help.configuration.httpSse.description')}
                  <code className="inline-code">{t('mcp.help.configuration.httpSse.example')}</code>
                </li>
              </ul>
            </section>

            <section className="help-section">
              <h4>
                <span className="codicon codicon-link-external"></span>
                {t('mcp.help.learnMore.title')}
              </h4>
              <p>
                {t('mcp.help.learnMore.description')}
                <a
                  href="https://modelcontextprotocol.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="help-link"
                >
                  modelcontextprotocol.io
                  <span className="codicon codicon-link-external"></span>
                </a>
              </p>
            </section>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-primary" onClick={onClose}>{t('mcp.help.gotIt')}</button>
        </div>
      </div>
    </div>
  );
}
