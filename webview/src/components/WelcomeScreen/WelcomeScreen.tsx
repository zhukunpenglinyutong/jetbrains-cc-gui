import { memo } from 'react';
import type { TFunction } from 'i18next';

import { BlinkingLogo } from '../BlinkingLogo';
import { AnimatedText } from '../AnimatedText';
import { APP_VERSION } from '../../version/version';

export interface WelcomeScreenProps {
  currentProvider: string;
  t: TFunction;
  onProviderChange: (provider: string) => void;
  onVersionClick?: () => void;
}

export const WelcomeScreen = memo(function WelcomeScreen({
  currentProvider,
  t,
  onProviderChange,
  onVersionClick,
}: WelcomeScreenProps): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#555',
        gap: '16px',
      }}
    >
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <BlinkingLogo provider={currentProvider} onProviderChange={onProviderChange} />
        <span
          className="version-tag"
          role="button"
          tabIndex={0}
          style={{ cursor: 'pointer' }}
          onClick={onVersionClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onVersionClick?.(); }}
        >
          v{APP_VERSION}
        </span>
      </div>
      <div>
        <AnimatedText text={t('chat.sendMessage', { provider: currentProvider === 'codex' ? 'Codex Cli' : 'Claude Code' })} />
      </div>
    </div>
  );
});
