import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RuntimeProviderSelect } from './RuntimeProviderSelect';
import {
  ARROW_CONTAINER_STYLE,
  ARROW_ICON_STYLE,
  ITEM_INFO_STYLE,
  SELECTOR_OPTION_RELATIVE_STYLE,
} from './selectorStyles';

/**
 * Runtime provider switching is only implemented for the Claude and Codex
 * harnesses (see RuntimeProviderSelect's providerKind). Hide the menu entry
 * for the beta CLI providers (grok/kimi/opencode/pi/omp/dsh).
 */
const RUNTIME_PROVIDER_SUPPORTED: Record<string, true> = { claude: true, codex: true };

interface RuntimeProviderMenuItemProps {
  currentProvider: string;
  active: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onProviderSwitched: (providerName: string) => void;
  onClose: () => void;
}

/**
 * RuntimeProviderMenuItem - Runtime provider trigger row inside the
 * ConfigSelect dropdown plus its embedded RuntimeProviderSelect submenu.
 * Only Claude/Codex support switching; other providers render nothing.
 */
export const RuntimeProviderMenuItem = ({
  currentProvider,
  active,
  onEnter,
  onLeave,
  onProviderSwitched,
  onClose,
}: RuntimeProviderMenuItemProps) => {
  const { t } = useTranslation();
  const runtimeProviderTriggerRef = useRef<HTMLDivElement>(null);

  if (!RUNTIME_PROVIDER_SUPPORTED[currentProvider]) {
    return null;
  }

  return (
    <>
      <div className="selector-divider" />

      <div
        ref={runtimeProviderTriggerRef}
        className="selector-option"
        data-testid="config-option-runtime-provider"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        style={SELECTOR_OPTION_RELATIVE_STYLE}
      >
        <span className="codicon codicon-vm-connect" />
        <div style={ITEM_INFO_STYLE}>
          <span>{t('config.runtimeProvider.title')}</span>
        </div>
        <div style={ARROW_CONTAINER_STYLE}>
          <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
        </div>

        {active && (
          <RuntimeProviderSelect
            currentProvider={currentProvider}
            embedded
            triggerRef={runtimeProviderTriggerRef}
            onProviderSwitched={onProviderSwitched}
            onClose={onClose}
          />
        )}
      </div>
    </>
  );
};

export default RuntimeProviderMenuItem;
