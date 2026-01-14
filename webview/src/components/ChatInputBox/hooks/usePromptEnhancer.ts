import { useCallback, useEffect, useState } from 'react';

declare global {
  interface Window {
    sendToJava?: (message: string) => void;
    updateEnhancedPrompt?: (result: string) => void;
  }
}

interface UsePromptEnhancerOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  selectedModel: string;
  setHasContent: (hasContent: boolean) => void;
  onInput?: (content: string) => void;
}

interface UsePromptEnhancerReturn {
  /** Whether prompt enhancement is in progress */
  isEnhancing: boolean;
  /** Whether enhancer dialog is shown */
  showEnhancerDialog: boolean;
  /** Original prompt text */
  originalPrompt: string;
  /** Enhanced prompt text */
  enhancedPrompt: string;
  /** Trigger prompt enhancement */
  handleEnhancePrompt: () => void;
  /** Use enhanced prompt */
  handleUseEnhancedPrompt: () => void;
  /** Keep original prompt */
  handleKeepOriginalPrompt: () => void;
  /** Close enhancer dialog */
  handleCloseEnhancerDialog: () => void;
}

/**
 * usePromptEnhancer - Handle prompt enhancement feature
 *
 * Allows users to enhance their prompts using AI.
 * Communicates with Java backend via window.sendToJava.
 */
export function usePromptEnhancer({
  editableRef,
  getTextContent,
  selectedModel,
  setHasContent,
  onInput,
}: UsePromptEnhancerOptions): UsePromptEnhancerReturn {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [showEnhancerDialog, setShowEnhancerDialog] = useState(false);
  const [originalPrompt, setOriginalPrompt] = useState('');
  const [enhancedPrompt, setEnhancedPrompt] = useState('');

  /**
   * Handle enhance prompt action
   */
  const handleEnhancePrompt = useCallback(() => {
    const content = getTextContent().trim();
    if (!content) {
      return;
    }

    // Set original prompt and open dialog
    setOriginalPrompt(content);
    setEnhancedPrompt('');
    setShowEnhancerDialog(true);
    setIsEnhancing(true);

    // Call backend for prompt enhancement, pass current selected model
    if (window.sendToJava) {
      window.sendToJava(
        `enhance_prompt:${JSON.stringify({ prompt: content, model: selectedModel })}`
      );
    }
  }, [getTextContent, selectedModel]);

  /**
   * Handle use enhanced prompt
   */
  const handleUseEnhancedPrompt = useCallback(() => {
    if (enhancedPrompt && editableRef.current) {
      // Replace input box content with enhanced prompt
      editableRef.current.innerText = enhancedPrompt;
      setHasContent(true);
      onInput?.(enhancedPrompt);
    }
    setShowEnhancerDialog(false);
    setIsEnhancing(false);
  }, [enhancedPrompt, editableRef, setHasContent, onInput]);

  /**
   * Handle keep original prompt
   */
  const handleKeepOriginalPrompt = useCallback(() => {
    setShowEnhancerDialog(false);
    setIsEnhancing(false);
  }, []);

  /**
   * Close enhancer dialog
   */
  const handleCloseEnhancerDialog = useCallback(() => {
    setShowEnhancerDialog(false);
    setIsEnhancing(false);
  }, []);

  // Register enhanced prompt result callback
  useEffect(() => {
    // Receive enhanced prompt
    window.updateEnhancedPrompt = (result: string) => {
      try {
        const data = JSON.parse(result);
        if (data.success && data.enhancedPrompt) {
          setEnhancedPrompt(data.enhancedPrompt);
        } else {
          setEnhancedPrompt(data.error || 'Enhancement failed');
        }
      } catch {
        setEnhancedPrompt(result);
      }
      setIsEnhancing(false);
    };

    return () => {
      delete window.updateEnhancedPrompt;
    };
  }, []);

  return {
    isEnhancing,
    showEnhancerDialog,
    originalPrompt,
    enhancedPrompt,
    handleEnhancePrompt,
    handleUseEnhancedPrompt,
    handleKeepOriginalPrompt,
    handleCloseEnhancerDialog,
  };
}
