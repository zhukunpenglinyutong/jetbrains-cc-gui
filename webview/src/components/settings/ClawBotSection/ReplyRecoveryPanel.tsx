import { useEffect, useState } from 'react';
import { Modal } from 'antd';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

const REASONS = ['READY', 'BODY_UNAVAILABLE', 'STORE_UNAVAILABLE', 'BINDING_CHANGED', 'SENDER_REVOKED',
  'EXPIRED', 'TARGET_CHANGED', 'RETRY_STARTED', 'TRANSPORT_NOT_READY', 'AUTO_RETRY'] as const;

export interface ReplyRecoveryItem {
  eventId: string;
  status: 'UNKNOWN' | 'FAILED';
  updatedAt: number;
  expiresAt: number;
  kind: 'FINAL_REPLY' | 'OTHER';
  reason: typeof REASONS[number];
  retryStatus: '' | 'QUEUED' | 'PENDING' | 'SENT' | 'UNKNOWN' | 'FAILED' | 'UNAVAILABLE';
}

export function parseReplyRecoveryItems(value: unknown): ReplyRecoveryItem[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const items: ReplyRecoveryItem[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.eventId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.eventId)
      || !['UNKNOWN', 'FAILED'].includes(item.status as string)
      || !['FINAL_REPLY', 'OTHER'].includes(item.kind as string)
      || !REASONS.includes(item.reason as ReplyRecoveryItem['reason'])
      || !['', 'QUEUED', 'PENDING', 'SENT', 'UNKNOWN', 'FAILED', 'UNAVAILABLE'].includes(item.retryStatus as string)
      || typeof item.updatedAt !== 'number' || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0
      || typeof item.expiresAt !== 'number' || !Number.isSafeInteger(item.expiresAt) || item.expiresAt < 0) return null;
    items.push({ eventId: item.eventId, status: item.status as ReplyRecoveryItem['status'],
      updatedAt: item.updatedAt, expiresAt: item.expiresAt, kind: item.kind as ReplyRecoveryItem['kind'],
      reason: item.reason as ReplyRecoveryItem['reason'], retryStatus: item.retryStatus as ReplyRecoveryItem['retryStatus'] });
  }
  return items;
}

interface Props {
  items: ReplyRecoveryItem[] | null;
  available: boolean;
  bindingRevision: number | null;
  currentBindingRevision: number | null;
  busy: boolean;
  onRefresh: () => void;
  onRetry: (eventId: string, bindingRevision: number) => void;
}

export default function ReplyRecoveryPanel({ items, available, bindingRevision, currentBindingRevision, busy, onRefresh, onRetry }: Props) {
  const { t } = useTranslation();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const selected = items?.find((item) => item.eventId === confirmation);
  const eligible = selected?.reason === 'READY' && available && bindingRevision !== null
    && bindingRevision === currentBindingRevision && !busy;

  useEffect(() => {
    setConfirmation(null);
  }, [currentBindingRevision]);

  return (
    <div className={`${styles.card} ${styles.recoveryCard}`}>
      <div className={styles.recoveryHeader}>
        <h4>{t('settings.clawBot.recovery.title')}</h4>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onRefresh}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
          {t('settings.clawBot.recovery.load')}
        </button>
      </div>
      <p className={styles.recoveryDescription}>{t('settings.clawBot.recovery.description')}</p>
      {items !== null && (!available || items.length === 0) && (
        <div role="status" className={`${styles.recoveryEmpty} ${!available ? styles.recoveryUnavailable : ''}`}>
          <span className={`codicon ${available ? 'codicon-inbox' : 'codicon-info'}`} aria-hidden="true" />
          <span>{t(available ? 'settings.clawBot.recovery.empty' : 'settings.clawBot.recovery.reasons.STORE_UNAVAILABLE')}</span>
        </div>
      )}
      {items?.map((item) => (
        <div className={styles.recoveryItem} key={item.eventId}>
          <div className={styles.recoveryItemHeading}>
            <strong>{t(`settings.clawBot.recovery.kinds.${item.kind}`)}</strong>
            <code className={styles.recoveryEventId}>{item.eventId.slice(0, 8)}</code>
          </div>
          <div className={styles.recoveryMeta}>
            <span className={item.status === 'UNKNOWN' ? styles.warning : styles.error}>{t(`settings.clawBot.recovery.statuses.${item.status}`)}</span>
            <span> · {new Date(item.updatedAt).toLocaleString()}</span>
          </div>
          <p className={styles.recoveryReason}>{t(`settings.clawBot.recovery.reasons.${item.reason}`)}</p>
          {item.retryStatus && <div role="status" className={styles.recoveryMeta}>{t('settings.clawBot.recovery.retryStatus')}: {t(`settings.clawBot.recovery.statuses.${item.retryStatus}`)}</div>}
          {item.expiresAt > 0 && <div className={styles.recoveryMeta}>{t('settings.clawBot.recovery.expires')}: {new Date(item.expiresAt).toLocaleString()}</div>}
          {item.reason === 'READY' && <button type="button" className={styles.secondaryButton}
            disabled={busy || !available || bindingRevision === null || bindingRevision !== currentBindingRevision} onClick={() => setConfirmation(item.eventId)}>
            {t('settings.clawBot.recovery.retry')}
          </button>}
        </div>
      ))}
      <Modal open={confirmation !== null} title={t('settings.clawBot.recovery.confirmTitle')}
        okText={t('settings.clawBot.recovery.confirm')} cancelText={t('settings.clawBot.recovery.cancel')}
        onCancel={() => setConfirmation(null)} okButtonProps={{ disabled: !eligible }}
        onOk={() => {
          if (eligible && confirmation !== null && bindingRevision !== null) {
            onRetry(confirmation, bindingRevision);
            setConfirmation(null);
          }
        }}>
        <p>{t('settings.clawBot.recovery.confirmDescription')}</p>
      </Modal>
    </div>
  );
}
