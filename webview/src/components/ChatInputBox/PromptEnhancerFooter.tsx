import { useTranslation } from 'react-i18next';

interface PromptEnhancerFooterProps {
  isLoading: boolean;
  enhancedPrompt: string;
  onKeepOriginal: () => void;
  onUseEnhanced: () => void;
}

/**
 * PromptEnhancerFooter - Footer buttons of the prompt enhancer dialog
 * Lets the user keep the original prompt or use the enhanced version.
 */
export const PromptEnhancerFooter = ({
  isLoading,
  enhancedPrompt,
  onKeepOriginal,
  onUseEnhanced,
}: PromptEnhancerFooterProps) => {
  const { t } = useTranslation();

  return (
    <div className="prompt-enhancer-footer">
      <button
        className="prompt-enhancer-btn secondary"
        onClick={onKeepOriginal}
        disabled={isLoading}
        type="button"
      >
        <span className="codicon codicon-close" />
        {t('promptEnhancer.keepOriginal')}
      </button>
      <button
        className="prompt-enhancer-btn primary"
        onClick={onUseEnhanced}
        disabled={!enhancedPrompt}
        type="button"
      >
        <span className="codicon codicon-check" />
        {t('promptEnhancer.useEnhanced')}
      </button>
    </div>
  );
};
