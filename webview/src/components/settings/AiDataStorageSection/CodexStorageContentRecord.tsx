import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './codexStorage.module.less';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Interpret known message shapes without treating local transcript content as HTML. */
export function readableStorageRecord(raw: string): { text: string; role?: 'user' | 'assistant' } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed)) return { text: raw };
    const item = object(parsed.payload) ? parsed.payload : parsed;
    const type = item.type;
    const role = item.role === 'user' || type === 'userMessage' || type === 'user_message' ? 'user'
      : item.role === 'assistant' || type === 'agentMessage' || type === 'agent_message' ? 'assistant' : undefined;
    const text = typeof item.text === 'string' ? item.text : typeof item.message === 'string' ? item.message
      : Array.isArray(item.content) ? item.content.flatMap(part => object(part) && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
    return text ? { text, role } : { text: raw };
  } catch {
    return { text: raw };
  }
}

interface CodexStorageContentRecordProps {
  record: { text: string; truncated: boolean };
  index: number;
}

export default function CodexStorageContentRecord({ record, index }: CodexStorageContentRecordProps) {
  const { t } = useTranslation();
  const display = useMemo(() => readableStorageRecord(record.text), [record.text]);
  const excerpt = display.text !== record.text || !record.text.trimStart().startsWith('{')
    ? display.text.replace(/\s+/g, ' ').slice(0, 100) : '';
  return <details className={styles.record}>
    <summary>
      <span>{display.role ? t(`settings.codexStorage.contentRoles.${display.role}`) : t('settings.codexStorage.record', { index })}</span>
      <span className={styles.excerpt}>{excerpt}</span>
      {record.truncated ? <span className={styles.warning}>{t('settings.codexStorage.truncated')}</span> : null}
      <span className="codicon codicon-chevron-right" aria-hidden="true" />
    </summary>
    <pre>{display.text}</pre>
    {display.text !== record.text ? <details className={styles.details}>
      <summary>{t('settings.codexStorage.rawRecord')}</summary><pre>{record.text}</pre>
    </details> : null}
  </details>;
}
