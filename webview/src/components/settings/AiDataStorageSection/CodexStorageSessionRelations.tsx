import { useTranslation } from 'react-i18next';
import type { CodexStorageSession } from './codexStorageBridge';
import styles from './codexStorage.module.less';

interface CodexStorageSessionRelationsProps {
  session: CodexStorageSession;
}

/** Parent names and child counts come from the host inventory, including sessions outside the current page. */
export default function CodexStorageSessionRelations({ session }: CodexStorageSessionRelationsProps) {
  const { t } = useTranslation();
  const subagent = session.subagent || !!session.parentId;
  const childCount = session.childCount ?? 0;
  if (!subagent && childCount === 0) return null;

  const parentTitle = session.parentTitle && session.parentTitle !== session.parentId ? session.parentTitle : '';
  return <div className={styles.relations}>
    <div className={styles.relationBadges}>
      <span className={styles.relationBadge}>
        <span className={`codicon codicon-${subagent ? 'git-merge' : 'comment-discussion'}`} aria-hidden="true" />
        {t(`settings.codexStorage.relations.${subagent ? 'subagent' : 'mainSession'}`)}
      </span>
      {childCount > 0 ? <span className={styles.childCount} title={t('settings.codexStorage.relations.childCountHint')}>
        {t('settings.codexStorage.relations.childCount', { count: childCount })}
      </span> : null}
    </div>
    {subagent ? <><div className={styles.parentSession} title={session.parentId ? `${parentTitle}\n${session.parentId}`.trim() : undefined}>
      <span className="codicon codicon-arrow-up" aria-hidden="true" />
      {session.parentId ? <>
        <span className={styles.parentLabel}>{t(`settings.codexStorage.relations.${session.parentIsSubagent === false ? 'mainSession' : 'parentSession'}`)}：</span>
        {parentTitle ? <span className={styles.parentTitle}>{parentTitle}</span> : null}
        <code>{session.parentId.slice(0, 8)}</code>
      </> : <span>{t('settings.codexStorage.relations.parentUnknown')}</span>}
    </div>
      {session.parentId && session.parentAvailable === false ? <span className={styles.parentMissing}>{t('settings.codexStorage.relations.parentMissing')}</span> : null}
    </> : null}
  </div>;
}
