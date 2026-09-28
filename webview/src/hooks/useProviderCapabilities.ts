import { useCallback, useState } from 'react';

export interface ProviderCapabilities {
  /** Whether the live runtime can inject a steer into the current turn */
  steer: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = { steer: false };

export interface UseProviderCapabilitiesReturn {
  capabilities: ProviderCapabilities;
  /** Apply a live [CAPABILITIES] payload */
  applyCapabilities: (next: ProviderCapabilities) => void;
  /** Reset to { steer: false } on session switch */
  resetCapabilities: () => void;
}

/**
 * Holds runtime provider capabilities advertised by [CAPABILITIES].
 * Defaults to { steer: false } until a live turn reports otherwise.
 */
export function useProviderCapabilities(): UseProviderCapabilitiesReturn {
  const [capabilities, setCapabilities] = useState<ProviderCapabilities>(DEFAULT_CAPABILITIES);

  const applyCapabilities = useCallback((next: ProviderCapabilities) => {
    setCapabilities({ steer: !!next.steer });
  }, []);

  const resetCapabilities = useCallback(() => {
    setCapabilities(DEFAULT_CAPABILITIES);
  }, []);

  return { capabilities, applyCapabilities, resetCapabilities };
}
