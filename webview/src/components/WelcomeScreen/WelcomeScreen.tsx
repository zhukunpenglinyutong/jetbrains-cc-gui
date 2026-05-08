import { memo } from 'react';
import type { TFunction } from 'i18next';

import { BlinkingLogo } from '../BlinkingLogo';
import { AnimatedText } from '../AnimatedText';
import { APP_VERSION } from '../../version/version';

const ROOT_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: '#555',
  gap: '16px',
};

const LOGO_WRAPPER_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const VERSION_TAG_STYLE: React.CSSProperties = { cursor: 'pointer' };

export interface WelcomeScreenProps {
  currentProvider: string;
  /** Current model ID for vendor-specific icon display */
  currentModelId?: string;
  t: TFunction;
  onProviderChange: (provider: string) => void;
  onVersionClick?: () => void;
}

export const WelcomeScreen = memo(function WelcomeScreen({
  currentProvider,
  currentModelId,
  t,
  onProviderChange,
  onVersionClick,
}: WelcomeScreenProps): React.ReactElement {
  const providerLabels: Record<string, string> = {
    claude: t('providers.claude.label'),
    codex: t('providers.codex.label'),
    gemini: t('providers.gemini.label'),
    opencode: t('providers.opencode.label'),
  };

  return (
    <div style={ROOT_STYLE}>
      <div style={LOGO_WRAPPER_STYLE}>
        <BlinkingLogo provider={currentProvider} modelId={currentModelId} onProviderChange={onProviderChange} />
        <span
          className="version-tag"
          role="button"
          tabIndex={0}
          style={VERSION_TAG_STYLE}
          onClick={onVersionClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onVersionClick?.(); }}
        >
          v{APP_VERSION}
        </span>
      </div>
      <div>
        <AnimatedText text={t('chat.sendMessage', { provider: providerLabels[currentProvider] ?? currentProvider })} />
      </div>
    </div>
  );
});
