import { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    sendToJava?: (message: string) => void;
    updateEnhancedPrompt?: (result: string) => void;
  }
}

interface UsePromptEnhancerOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  setHasContent: (hasContent: boolean) => void;
  onInput?: (content: string) => void;
  /** Current chat CLI provider — used in auto mode so enhancer follows chat model */
  currentProvider?: string;
  /** Current chat model id — used in auto mode so enhancer follows chat model */
  selectedModel?: string;
}

/** Runtime usage shown in the enhance dialog (mode / CLI / model). */
export interface EnhanceUsageInfo {
  provider: string | null;
  model: string | null;
  resolutionSource: 'manual' | 'auto' | 'unavailable' | null;
}

interface UsePromptEnhancerReturn {
  /** Whether prompt enhancement is in progress */
  isEnhancing: boolean;
  /** Whether enhancer dialog is shown */
  showEnhancerDialog: boolean;
  /** Original prompt text */
  originalPrompt: string;
  /** Enhanced prompt text (may stream in while isEnhancing) */
  enhancedPrompt: string;
  /** Provider/model/mode used for the active enhance request */
  usageInfo: EnhanceUsageInfo | null;
  /** Trigger prompt enhancement */
  handleEnhancePrompt: () => void;
  /** Use enhanced prompt */
  handleUseEnhancedPrompt: () => void;
  /** Keep original prompt */
  handleKeepOriginalPrompt: () => void;
  /** Close enhancer dialog */
  handleCloseEnhancerDialog: () => void;
}

export interface EnhancedPromptPayload {
  success?: boolean;
  enhancedPrompt?: string;
  error?: string;
  /** false while streaming partial text; true (or omitted) when finished */
  done?: boolean;
  /** Effective CLI provider id (claude/codex/grok/...) */
  provider?: string | null;
  /** Model id for the effective provider */
  model?: string | null;
  /** auto | manual | unavailable */
  resolutionSource?: string | null;
}

function parseResolutionSource(
  value: unknown
): EnhanceUsageInfo['resolutionSource'] {
  if (value === 'manual' || value === 'auto' || value === 'unavailable') {
    return value;
  }
  return null;
}

/**
 * Apply a backend enhance payload to UI state.
 * Extracted for unit testing without mounting the full hook.
 */
export function applyEnhancedPromptPayload(
  data: EnhancedPromptPayload,
  setters: {
    setEnhancedPrompt: (text: string) => void;
    setIsEnhancing: (value: boolean) => void;
    setUsageInfo?: (info: EnhanceUsageInfo | null) => void;
  }
): void {
  const done = data.done !== false;
  if (data.success && data.enhancedPrompt) {
    setters.setEnhancedPrompt(data.enhancedPrompt);
  } else if (done) {
    setters.setEnhancedPrompt(data.error || data.enhancedPrompt || 'Enhancement failed');
  } else if (data.enhancedPrompt) {
    // Streaming progress without success flag — still show text
    setters.setEnhancedPrompt(data.enhancedPrompt);
  }

  if (
    setters.setUsageInfo
    && (data.provider !== undefined
      || data.model !== undefined
      || data.resolutionSource !== undefined)
  ) {
    setters.setUsageInfo({
      provider: typeof data.provider === 'string' && data.provider.trim()
        ? data.provider.trim()
        : null,
      model: typeof data.model === 'string' && data.model.trim()
        ? data.model.trim()
        : null,
      resolutionSource: parseResolutionSource(data.resolutionSource),
    });
  }

  if (done) {
    setters.setIsEnhancing(false);
  }
}

/**
 * usePromptEnhancer - Handle prompt enhancement feature
 *
 * Allows users to enhance their prompts using AI.
 * Communicates with Java backend via window.sendToJava.
 * Supports progressive streaming updates (done: false) while generating.
 */
export function usePromptEnhancer({
  editableRef,
  getTextContent,
  setHasContent,
  onInput,
  currentProvider,
  selectedModel,
}: UsePromptEnhancerOptions): UsePromptEnhancerReturn {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [showEnhancerDialog, setShowEnhancerDialog] = useState(false);
  const [originalPrompt, setOriginalPrompt] = useState('');
  const [enhancedPrompt, setEnhancedPrompt] = useState('');
  const [usageInfo, setUsageInfo] = useState<EnhanceUsageInfo | null>(null);
  /** Bumped on close / new request to ignore late backend updates. */
  const requestIdRef = useRef(0);
  /** Generation id for the currently open enhance request. */
  const activeRequestIdRef = useRef(0);

  /**
   * Handle enhance prompt action
   */
  const handleEnhancePrompt = useCallback(() => {
    const content = getTextContent().trim();
    if (!content) {
      return;
    }

    requestIdRef.current += 1;
    activeRequestIdRef.current = requestIdRef.current;
    // Set original prompt and open dialog
    setOriginalPrompt(content);
    setEnhancedPrompt('');
    setUsageInfo(null);
    setShowEnhancerDialog(true);
    setIsEnhancing(true);

    // Call backend for prompt enhancement.
    // chatProvider/chatModel let auto mode follow the model selected in chat.
    if (window.sendToJava) {
      const payload: {
        prompt: string;
        chatProvider?: string;
        chatModel?: string;
      } = { prompt: content };
      const provider = currentProvider?.trim();
      const model = selectedModel?.trim();
      if (provider) payload.chatProvider = provider;
      if (model) payload.chatModel = model;
      window.sendToJava(`enhance_prompt:${JSON.stringify(payload)}`);
    }
  }, [getTextContent, currentProvider, selectedModel]);

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
    requestIdRef.current += 1;
    setShowEnhancerDialog(false);
    setIsEnhancing(false);
  }, [enhancedPrompt, editableRef, setHasContent, onInput]);

  /**
   * Handle keep original prompt
   */
  const handleKeepOriginalPrompt = useCallback(() => {
    requestIdRef.current += 1;
    setShowEnhancerDialog(false);
    setIsEnhancing(false);
  }, []);

  /**
   * Close enhancer dialog
   */
  const handleCloseEnhancerDialog = useCallback(() => {
    requestIdRef.current += 1;
    setShowEnhancerDialog(false);
    setIsEnhancing(false);
  }, []);

  // Register enhanced prompt result callback (supports streaming deltas)
  useEffect(() => {
    window.updateEnhancedPrompt = (result: string) => {
      // Drop updates that belong to a closed / superseded request
      if (requestIdRef.current !== activeRequestIdRef.current) {
        return;
      }
      try {
        const data = JSON.parse(result) as EnhancedPromptPayload;
        applyEnhancedPromptPayload(data, {
          setEnhancedPrompt,
          setIsEnhancing,
          setUsageInfo,
        });
      } catch {
        setEnhancedPrompt(result);
        setIsEnhancing(false);
      }
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
    usageInfo,
    handleEnhancePrompt,
    handleUseEnhancedPrompt,
    handleKeepOriginalPrompt,
    handleCloseEnhancerDialog,
  };
}
