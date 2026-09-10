import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  petBridge,
  type CodexPetAction,
  type LocalCodexPet,
} from '../../codexPet/petBridge';
import { petErrorDescriptor } from './utils';
import styles from './style.module.less';

export const ACTION_PREVIEW_METADATA: Record<CodexPetAction, { spriteRow: number; frameCount: number }> = {
  idle: { spriteRow: 0, frameCount: 6 },
  'running-right': { spriteRow: 1, frameCount: 8 },
  'running-left': { spriteRow: 2, frameCount: 8 },
  waving: { spriteRow: 3, frameCount: 4 },
  jumping: { spriteRow: 4, frameCount: 5 },
  failed: { spriteRow: 5, frameCount: 8 },
  waiting: { spriteRow: 6, frameCount: 6 },
  running: { spriteRow: 7, frameCount: 6 },
  review: { spriteRow: 8, frameCount: 6 },
};

function SpritePreview({
  src,
  spriteSheet,
  action = 'idle',
  frame = 0,
  animate = true,
}: {
  src: string;
  spriteSheet: boolean;
  action?: CodexPetAction;
  frame?: number;
  animate?: boolean;
}) {
  if (spriteSheet) {
    const metadata = ACTION_PREVIEW_METADATA[action];
    const safeFrame = Math.max(0, Math.min(frame, metadata.frameCount - 1));
    return (
      <span
        className={`${styles.spritePreview}${animate ? ` ${styles.spritePreviewAnimated}` : ''}`}
        style={{
          backgroundImage: `url("${src}")`,
          backgroundPosition: `${(safeFrame * 100) / 7}% ${(metadata.spriteRow * 100) / 8}%`,
        }}
      />
    );
  }
  return <img className={styles.staticPreview} src={src} alt="" draggable={false} />;
}

export function LocalPetPreview({
  pet,
  action,
  frame,
  animate,
}: {
  pet: LocalCodexPet;
  action?: CodexPetAction;
  frame?: number;
  animate?: boolean;
}) {
  const [preview, setPreview] = useState(() => pet.dataUrl
    ? { dataUrl: pet.dataUrl, spriteSheet: pet.spriteSheet }
    : null);
  const [loading, setLoading] = useState(!pet.dataUrl);

  useEffect(() => {
    if (pet.dataUrl) {
      setPreview({ dataUrl: pet.dataUrl, spriteSheet: pet.spriteSheet });
      setLoading(false);
      return undefined;
    }
    setPreview(null);
    setLoading(true);
    const unsubscribe = petBridge.subscribeLocalPreview((payload) => {
      if (payload.petId !== pet.id) return;
      setLoading(false);
      setPreview(payload.dataUrl
        ? { dataUrl: payload.dataUrl, spriteSheet: payload.spriteSheet }
        : null);
    });
    petBridge.getLocalPreview(pet.id);
    return unsubscribe;
  }, [pet.dataUrl, pet.id, pet.spriteSheet]);

  if (preview) {
    return (
      <SpritePreview
        src={preview.dataUrl}
        spriteSheet={preview.spriteSheet}
        action={action}
        frame={frame}
        animate={animate}
      />
    );
  }
  return (
    <span
      className={`codicon ${loading ? `codicon-loading ${styles.spinning}` : 'codicon-warning'}`}
      aria-hidden="true"
    />
  );
}

export function RemoteSpritePreview({
  slug,
  label,
  unavailableLabel,
}: {
  slug: string;
  label: string;
  unavailableLabel: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    setStatus('loading');
    setDataUrl(null);
    setErrorCode(null);
    const unsubscribe = petBridge.subscribePreview((preview) => {
      if (preview.slug !== slug) return;
      if (preview.dataUrl) {
        setDataUrl(preview.dataUrl);
        setStatus('loaded');
      } else {
        setErrorCode(preview.error ?? null);
        setStatus('error');
      }
    });
    petBridge.getPreview(slug);
    return unsubscribe;
  }, [slug]);

  const errorText = errorCode
    ? (() => {
        const descriptor = petErrorDescriptor(errorCode);
        return t(descriptor.key, descriptor.params);
      })()
    : unavailableLabel;

  return (
    <div
      className={`${styles.remotePreview}${status === 'loaded' ? ` ${styles.remotePreviewLoaded}` : ''}`}
      role="img"
      aria-label={label}
      style={status === 'loaded' && dataUrl
        ? { backgroundImage: `url(${JSON.stringify(dataUrl)})` }
        : undefined}
    >
      {status === 'loading' && (
        <span className={`codicon codicon-loading ${styles.spinning}`} aria-hidden="true" />
      )}
      {status === 'error' && (
        <span
          className={`codicon codicon-warning ${styles.previewError}`}
          title={errorText}
          aria-label={errorText}
        />
      )}
    </div>
  );
}
