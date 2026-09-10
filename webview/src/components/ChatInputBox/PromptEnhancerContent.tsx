import { useTranslation } from 'react-i18next';

interface PromptEnhancerContentProps {
  isLoading: boolean;
  originalPrompt: string;
  enhancedPrompt: string;
}

/**
 * PromptEnhancerContent - Content area of the prompt enhancer dialog
 * Displays the original prompt and the (streaming) enhanced prompt side by side.
 */
export const PromptEnhancerContent = ({
  isLoading,
  originalPrompt,
  enhancedPrompt,
}: PromptEnhancerContentProps) => {
  const { t } = useTranslation();

  return (
    <div className="prompt-enhancer-content">
      {/* Original prompt */}
      <div className="prompt-section">
        <div className="prompt-section-header">
          <span className="codicon codicon-edit" />
          <span>{t('promptEnhancer.originalPrompt')}</span>
        </div>
        <div className="prompt-text original-prompt">
          {originalPrompt}
        </div>
      </div>

      {/* Enhanced prompt */}
      <div className="prompt-section">
        <div className="prompt-section-header">
          <span className="codicon codicon-sparkle" />
          <span>{t('promptEnhancer.enhancedPrompt')}</span>
        </div>
        <div className="prompt-text enhanced-prompt">
          {isLoading && !enhancedPrompt ? (
            <div className="prompt-loading">
              <span className="codicon codicon-loading codicon-modifier-spin" />
              <span>{t('promptEnhancer.enhancing')}</span>
            </div>
          ) : (
            <>
              {enhancedPrompt || t('promptEnhancer.enhancing')}
              {isLoading && enhancedPrompt ? (
                <span className="prompt-streaming-cursor" aria-hidden="true">
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
