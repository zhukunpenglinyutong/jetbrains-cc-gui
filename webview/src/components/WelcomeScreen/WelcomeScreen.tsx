import type { TFunction } from 'i18next';

import { BlinkingLogo } from '../BlinkingLogo';
import { AnimatedText } from '../AnimatedText';
import { APP_VERSION } from '../../version/version';

export interface WelcomeScreenProps {
  currentProvider: string;
  t: TFunction;
  onProviderChange: (provider: string) => void;
}

export function WelcomeScreen({
  currentProvider,
  t,
  onProviderChange,
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
        <span className="version-tag">
          v{APP_VERSION}
        </span>
      </div>
      <div>
        <AnimatedText text={t('chat.sendMessage', { provider: currentProvider === 'codex' ? 'Codex Cli' : 'Claude Code' })} />
      </div>
    </div>
  );
}
