import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface PromptEnhancerDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  originalPrompt: string;
  enhancedPrompt: string;
  onUseEnhanced: () => void;
  onKeepOriginal: () => void;
  onClose: () => void;
}

/**
 * PromptEnhancerDialog - Prompt enhancement dialog
 * Displays original and enhanced prompts, letting the user choose which version to use
 */
export const PromptEnhancerDialog = ({
  isOpen,
  isLoading,
  originalPrompt,
  enhancedPrompt,
  onUseEnhanced,
  onKeepOriginal,
  onClose,
}: PromptEnhancerDialogProps) => {
  const { t } = useTranslation();

  // Handle keyboard events
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && !isLoading && enhancedPrompt) {
      e.preventDefault();
      onUseEnhanced();
    }
  }, [onClose, onUseEnhanced, isLoading, enhancedPrompt]);

  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) {
    return null;
  }

  // Close on overlay click
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="prompt-enhancer-overlay" onClick={handleOverlayClick}>
      <div className="prompt-enhancer-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="prompt-enhancer-header">
          <div className="prompt-enhancer-title">
            <span className="codicon codicon-sparkle" />
            <h3>{t('promptEnhancer.title')}</h3>
          </div>
          <button className="prompt-enhancer-close" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        {/* Content area */}
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
              {isLoading ? (
                <div className="prompt-loading">
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                  <span>{t('promptEnhancer.enhancing')}</span>
                </div>
              ) : (
                enhancedPrompt || t('promptEnhancer.enhancing')
              )}
            </div>
          </div>
        </div>

        {/* Footer buttons */}
        <div className="prompt-enhancer-footer">
          <button
            className="prompt-enhancer-btn secondary"
            onClick={onKeepOriginal}
            disabled={isLoading}
          >
            <span className="codicon codicon-close" />
            {t('promptEnhancer.keepOriginal')}
          </button>
          <button
            className="prompt-enhancer-btn primary"
            onClick={onUseEnhanced}
            disabled={isLoading || !enhancedPrompt}
          >
            <span className="codicon codicon-check" />
            {t('promptEnhancer.useEnhanced')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromptEnhancerDialog;

