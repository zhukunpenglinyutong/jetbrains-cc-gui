import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnhanceUsageInfo } from './hooks/usePromptEnhancer';
import { PromptEnhancerMeta } from './PromptEnhancerMeta';
import { PromptEnhancerContent } from './PromptEnhancerContent';
import { PromptEnhancerFooter } from './PromptEnhancerFooter';

interface PromptEnhancerDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  originalPrompt: string;
  enhancedPrompt: string;
  usageInfo?: EnhanceUsageInfo | null;
  onUseEnhanced: () => void;
  onKeepOriginal: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
}

/**
 * PromptEnhancerDialog - Prompt enhancement dialog
 * Displays original and enhanced prompts, letting the user choose which version to use.
 * Shows which mode / CLI / model is performing the enhancement.
 */
export const PromptEnhancerDialog = ({
  isOpen,
  isLoading,
  originalPrompt,
  enhancedPrompt,
  usageInfo = null,
  onUseEnhanced,
  onKeepOriginal,
  onClose,
  onOpenSettings,
}: PromptEnhancerDialogProps) => {
  const { t } = useTranslation();

  // Handle keyboard events
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && enhancedPrompt) {
      e.preventDefault();
      onUseEnhanced();
    }
  }, [onClose, onUseEnhanced, enhancedPrompt]);

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
          <button className="prompt-enhancer-close" onClick={onClose} type="button" aria-label={t('common.close', { defaultValue: 'Close' })}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        {/* Usage meta: mode / CLI / model + settings shortcut */}
        <PromptEnhancerMeta usageInfo={usageInfo} onOpenSettings={onOpenSettings} />

        {/* Content area */}
        <PromptEnhancerContent
          isLoading={isLoading}
          originalPrompt={originalPrompt}
          enhancedPrompt={enhancedPrompt}
        />

        {/* Footer buttons */}
        <PromptEnhancerFooter
          isLoading={isLoading}
          enhancedPrompt={enhancedPrompt}
          onKeepOriginal={onKeepOriginal}
          onUseEnhanced={onUseEnhanced}
        />
      </div>
    </div>
  );
};

export default PromptEnhancerDialog;
