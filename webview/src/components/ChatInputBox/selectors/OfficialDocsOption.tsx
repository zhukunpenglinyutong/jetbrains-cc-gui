import { useTranslation } from 'react-i18next';
import { openBrowser } from '../../../utils/bridge';
import {
  ARROW_CONTAINER_STYLE,
  ARROW_ICON_STYLE,
  ITEM_INFO_STYLE,
} from './selectorStyles';

const DOCS_URLS: Record<string, string> = {
  zh: 'https://docs.mossx.ai/jetbrains',
  'zh-TW': 'https://docs.mossx.ai/zh-Hant/jetbrains/index',
};
const DEFAULT_DOCS_URL = 'https://docs.mossx.ai/en/jetbrains/index';

const resolveDocsUrl = (language: string): string => {
  if (language.startsWith('zh-TW') || language.startsWith('zh-Hant')) {
    return DOCS_URLS['zh-TW'];
  }
  if (language.startsWith('zh')) {
    return DOCS_URLS.zh;
  }
  return DEFAULT_DOCS_URL;
};

interface OfficialDocsOptionProps {
  onClose: () => void;
  onMouseEnter: () => void;
}

/**
 * OfficialDocsOption - Footer row of the ConfigSelect dropdown linking to the
 * localized official documentation.
 */
export const OfficialDocsOption = ({ onClose, onMouseEnter }: OfficialDocsOptionProps) => {
  const { t, i18n } = useTranslation();

  return (
    <div
      className="selector-option"
      data-testid="config-option-official-docs"
      onClick={(e) => {
        e.stopPropagation();
        openBrowser(resolveDocsUrl(i18n.language));
        onClose();
      }}
      onMouseEnter={onMouseEnter}
    >
      <span className="codicon codicon-book" />
      <div style={ITEM_INFO_STYLE}>
        <span>{t('config.officialDocs')}</span>
      </div>
      <div style={ARROW_CONTAINER_STYLE}>
        <span className="codicon codicon-link-external" style={ARROW_ICON_STYLE} />
      </div>
    </div>
  );
};

export default OfficialDocsOption;
