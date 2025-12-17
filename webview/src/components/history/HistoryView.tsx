import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryData, HistorySessionSummary } from '../../types';
import VirtualList from './VirtualList';

interface HistoryViewProps {
  historyData: HistoryData | null;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void; // 添加删除回调
  onExportSession: (sessionId: string, title: string) => void; // 添加导出回调
}

const formatTimeAgo = (timestamp: string | undefined, t: (key: string) => string) => {
  if (!timestamp) {
    return '';
  }
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  const units: [number, string][] = [
    [31536000, t('history.timeAgo.yearsAgo')],
    [2592000, t('history.timeAgo.monthsAgo')],
    [86400, t('history.timeAgo.daysAgo')],
    [3600, t('history.timeAgo.hoursAgo')],
    [60, t('history.timeAgo.minutesAgo')],
  ];

  for (const [unitSeconds, label] of units) {
    const interval = Math.floor(seconds / unitSeconds);
    if (interval >= 1) {
      return `${interval} ${label}`;
    }
  }
  return `${Math.max(seconds, 1)} ${t('history.timeAgo.secondsAgo')}`;
};

const HistoryView = ({ historyData, onLoadSession, onDeleteSession, onExportSession }: HistoryViewProps) => {
  const { t } = useTranslation();
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight || 600);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null); // 记录待删除的会话ID

  useEffect(() => {
    const handleResize = () => setViewportHeight(window.innerHeight || 600);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const sessions = historyData?.sessions ?? [];

  const infoBar = useMemo(() => {
    if (!historyData) {
      return '';
    }
    const sessionCount = sessions.length;
    const messageCount = historyData.total ?? 0;
    return t('history.totalSessions', { count: sessionCount, total: messageCount });
  }, [historyData, sessions.length, t]);

  if (!historyData) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📜</div>
          <div>{t('history.loading')}</div>
        </div>
      </div>
    );
  }

  if (!historyData.success) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
          <div>{historyData.error ?? t('history.loadFailed')}</div>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📭</div>
          <div>{t('history.noSessions')}</div>
          <div style={{ fontSize: '12px', marginTop: '8px' }}>{t('history.noSessionsDesc')}</div>
        </div>
      </div>
    );
  }

  // 处理删除按钮点击(阻止事件冒泡,避免触发会话加载)
  const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // 阻止点击事件冒泡到父元素
    setDeletingSessionId(sessionId); // 显示确认对话框
  };

  // 处理导出按钮点击(阻止事件冒泡,避免触发会话加载)
  const handleExportClick = (e: React.MouseEvent, sessionId: string, title: string) => {
    e.stopPropagation(); // 阻止点击事件冒泡到父元素
    onExportSession(sessionId, title);
  };

  // 确认删除
  const confirmDelete = () => {
    if (deletingSessionId) {
      onDeleteSession(deletingSessionId);
      setDeletingSessionId(null);
    }
  };

  // 取消删除
  const cancelDelete = () => {
    setDeletingSessionId(null);
  };

  const renderHistoryItem = (session: HistorySessionSummary) => (
    <div key={session.sessionId} className="history-item" onClick={() => onLoadSession(session.sessionId)}>
      <div className="history-item-header">
        <div className="history-item-title">{session.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="history-item-time">{formatTimeAgo(session.lastTimestamp, t)}</div>
          {/* 导出按钮 */}
          <button
            className="history-export-btn"
            onClick={(e) => handleExportClick(e, session.sessionId, session.title)}
            title={t('history.exportSession')}
            aria-label={t('history.exportSession')}
          >
            <span className="codicon codicon-arrow-down"></span>
          </button>
          {/* 删除按钮 */}
          <button
            className="history-delete-btn"
            onClick={(e) => handleDeleteClick(e, session.sessionId)}
            title={t('history.deleteSession')}
            aria-label={t('history.deleteSession')}
          >
            <span className="codicon codicon-trash"></span>
          </button>
        </div>
      </div>
      <div className="history-item-meta">
        <span>{t('history.messageCount', { count: session.messageCount })}</span>
        <span style={{ fontFamily: 'monospace', color: '#666' }}>{session.sessionId.slice(0, 8)}</span>
      </div>
    </div>
  );

  const listHeight = Math.max(240, viewportHeight - 118);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid #3e3e42', flexShrink: 0 }}>
        <div style={{ fontSize: '12px', color: '#858585' }}>{infoBar}</div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <VirtualList
          items={sessions}
          itemHeight={78}
          height={listHeight}
          renderItem={renderHistoryItem}
          getItemKey={(session) => session.sessionId}
          className="messages-container"
        />
      </div>

      {/* 删除确认对话框 */}
      {deletingSessionId && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>{t('history.confirmDelete')}</h3>
            <p>{t('history.deleteMessage')}</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={cancelDelete}>
                {t('common.cancel')}
              </button>
              <button className="modal-btn modal-btn-danger" onClick={confirmDelete}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryView;

