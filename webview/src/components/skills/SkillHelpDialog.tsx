import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '../../utils/copyUtils';

const COPIED_INDICATOR_STYLE: React.CSSProperties = {
  marginLeft: '8px',
  color: 'var(--vscode-charts-green, #4caf50)',
  fontSize: '12px',
};

interface SkillHelpDialogProps {
  onClose: () => void;
  currentProvider?: string;
}

/**
 * Skills Help Dialog
 * Explains what Skills are and how to use them
 * Shows provider-specific content for Claude vs Codex
 */
export function SkillHelpDialog({ onClose, currentProvider = 'claude' }: SkillHelpDialogProps) {
  const { t } = useTranslation();
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  // Prevent event bubbling
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Copy link and show brief inline feedback
  const handleLinkClick = useCallback(async (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    const success = await copyToClipboard(url);
    if (success) {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    }
  }, []);

  const isCodex = currentProvider === 'codex';
  // Use provider-specific i18n key prefix
  const hp = isCodex ? 'skills.help.codex' : 'skills.help';

  return (
    <div className="skill-dialog-backdrop" onClick={handleBackdropClick}>
      <div className="skill-dialog help-dialog">
        {/* Header */}
        <div className="dialog-header">
          <h3>{t(`${hp}.title`)}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        {/* Content */}
        <div className="dialog-content help-content">
          <section className="help-section">
            <h4>
              <span className="codicon codicon-extensions"></span>
              {t(`${hp}.overview.title`)}
            </h4>
            <p>{t(`${hp}.overview.description`)}</p>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-folder"></span>
              {t(`${hp}.structure.title`)}
            </h4>
            <p>{t(`${hp}.structure.description`)}</p>
            <pre className="code-block">
{t(`${hp}.structure.example`)}
            </pre>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-file-code"></span>
              {t(`${hp}.format.title`)}
            </h4>
            <p>{t(`${hp}.format.description`)}</p>
            <pre className="code-block">
{t(`${hp}.format.example`)}
            </pre>
            <p className="hint-text">
              {t(`${hp}.format.hint`)}
            </p>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-gear"></span>
              {t(`${hp}.configuration.title`)}
            </h4>
            <p>{t(`${hp}.configuration.description`)}</p>
            {isCodex ? (
              <ul>
                <li>
                  <strong>{t(`${hp}.configuration.userPath.label`)}</strong>：{t(`${hp}.configuration.userPath.description`)}
                </li>
                <li>
                  <strong>{t(`${hp}.configuration.repoPath.label`)}</strong>：{t(`${hp}.configuration.repoPath.description`)}
                </li>
                <li>
                  <strong>{t(`${hp}.configuration.configToml.label`)}</strong>：{t(`${hp}.configuration.configToml.description`)}
                </li>
              </ul>
            ) : (
              <ul>
                <li>
                  <strong>{t(`${hp}.configuration.localPath.label`)}</strong>：{t(`${hp}.configuration.localPath.description`)}
                </li>
                <li>
                  <strong>{t(`${hp}.configuration.relativePath.label`)}</strong>：{t(`${hp}.configuration.relativePath.description`)}
                </li>
                <li>
                  <strong>{t(`${hp}.configuration.absolutePath.label`)}</strong>：{t(`${hp}.configuration.absolutePath.description`)}
                </li>
              </ul>
            )}
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-lightbulb"></span>
              {t(`${hp}.tips.title`)}
            </h4>
            <ul>
              <li>{t(`${hp}.tips.item1`)}</li>
              <li>{t(`${hp}.tips.item2`)}</li>
              <li>{t(`${hp}.tips.item3`)}</li>
              <li>{t(`${hp}.tips.item4`)}</li>
              <li>{t(`${hp}.tips.item5`)}</li>
            </ul>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-link-external"></span>
              {t(`${hp}.learnMore.title`)}
            </h4>
            <p>{t(`${hp}.learnMore.description`)}</p>
            {isCodex ? (
              <ul>
                <li>
                  <a
                    href="https://codex.openai.com/docs/skills"
                    onClick={(e) => handleLinkClick(e, 'https://codex.openai.com/docs/skills')}
                  >
                    {t(`${hp}.learnMore.link1`)}
                  </a>
                  {copiedUrl === 'https://codex.openai.com/docs/skills' && (
                    <span style={COPIED_INDICATOR_STYLE}>✓ {t('mcp.linkCopied')}</span>
                  )}
                </li>
              </ul>
            ) : (
              <ul>
                <li>
                  <a
                    href="https://support.claude.com/en/articles/12512176-what-are-skills"
                    onClick={(e) => handleLinkClick(e, 'https://support.claude.com/en/articles/12512176-what-are-skills')}
                  >
                    {t(`${hp}.learnMore.link1`)}
                  </a>
                  {copiedUrl === 'https://support.claude.com/en/articles/12512176-what-are-skills' && (
                    <span style={COPIED_INDICATOR_STYLE}>✓ {t('mcp.linkCopied')}</span>
                  )}
                </li>
                <li>
                  <a
                    href="https://support.claude.com/en/articles/12512198-creating-custom-skills"
                    onClick={(e) => handleLinkClick(e, 'https://support.claude.com/en/articles/12512198-creating-custom-skills')}
                  >
                    {t(`${hp}.learnMore.link2`)}
                  </a>
                  {copiedUrl === 'https://support.claude.com/en/articles/12512198-creating-custom-skills' && (
                    <span style={COPIED_INDICATOR_STYLE}>✓ {t('mcp.linkCopied')}</span>
                  )}
                </li>
                <li>
                  <a
                    href="https://github.com/anthropics/skills"
                    onClick={(e) => handleLinkClick(e, 'https://github.com/anthropics/skills')}
                  >
                    {t(`${hp}.learnMore.link3`)}
                  </a>
                  {copiedUrl === 'https://github.com/anthropics/skills' && (
                    <span style={COPIED_INDICATOR_STYLE}>✓ {t('mcp.linkCopied')}</span>
                  )}
                </li>
              </ul>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="dialog-footer">
          <button className="btn-primary" onClick={onClose}>
            {t('mcp.help.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
