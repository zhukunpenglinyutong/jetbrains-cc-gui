import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '../../utils/helpers';

interface SkillHelpDialogProps {
  onClose: () => void;
}

/**
 * Skills Help Dialog
 * Explains what Skills are and how to use them
 */
export function SkillHelpDialog({ onClose }: SkillHelpDialogProps) {
  const { t } = useTranslation();
  // 阻止事件冒泡
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Copy link and show alert
  const handleLinkClick = async (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    const success = await copyToClipboard(url);
    if (success) {
      alert(t('mcp.linkCopied'));
    }
  };

  return (
    <div className="skill-dialog-backdrop" onClick={handleBackdropClick}>
      <div className="skill-dialog help-dialog">
        {/* Header */}
        <div className="dialog-header">
          <h3>{t('skills.help.title')}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        {/* Content */}
        <div className="dialog-content help-content">
          <section className="help-section">
            <h4>
              <span className="codicon codicon-extensions"></span>
              {t('skills.help.overview.title')}
            </h4>
            <p>
              {t('skills.help.overview.description')}
            </p>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-folder"></span>
              {t('skills.help.structure.title')}
            </h4>
            <p>{t('skills.help.structure.description')}</p>
            <pre className="code-block">
{t('skills.help.structure.example')}
            </pre>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-file-code"></span>
              {t('skills.help.format.title')}
            </h4>
            <p>{t('skills.help.format.description')}</p>
            <pre className="code-block">
{t('skills.help.format.example')}
            </pre>
            <p className="hint-text">
              {t('skills.help.format.hint')}
            </p>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-gear"></span>
              {t('skills.help.configuration.title')}
            </h4>
            <p>{t('skills.help.configuration.description')}</p>
            <ul>
              <li>
                <strong>{t('skills.help.configuration.localPath.label')}</strong>：{t('skills.help.configuration.localPath.description')}
              </li>
              <li>
                <strong>{t('skills.help.configuration.relativePath.label')}</strong>：{t('skills.help.configuration.relativePath.description')}
              </li>
              <li>
                <strong>{t('skills.help.configuration.absolutePath.label')}</strong>：{t('skills.help.configuration.absolutePath.description')}
              </li>
            </ul>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-lightbulb"></span>
              {t('skills.help.tips.title')}
            </h4>
            <ul>
              <li>{t('skills.help.tips.item1')}</li>
              <li>{t('skills.help.tips.item2')}</li>
              <li>{t('skills.help.tips.item3')}</li>
              <li>{t('skills.help.tips.item4')}</li>
              <li>{t('skills.help.tips.item5')}</li>
            </ul>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-link-external"></span>
              {t('skills.help.learnMore.title')}
            </h4>
            <p>{t('skills.help.learnMore.description')}</p>
            <ul>
              <li>
                <a
                  href="https://support.claude.com/en/articles/12512176-what-are-skills"
                  onClick={(e) => handleLinkClick(e, 'https://support.claude.com/en/articles/12512176-what-are-skills')}
                >
                  {t('skills.help.learnMore.link1')}
                </a>
              </li>
              <li>
                <a
                  href="https://support.claude.com/en/articles/12512198-creating-custom-skills"
                  onClick={(e) => handleLinkClick(e, 'https://support.claude.com/en/articles/12512198-creating-custom-skills')}
                >
                  {t('skills.help.learnMore.link2')}
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/anthropics/skills"
                  onClick={(e) => handleLinkClick(e, 'https://github.com/anthropics/skills')}
                >
                  {t('skills.help.learnMore.link3')}
                </a>
              </li>
            </ul>
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
