import { useEffect, useMemo, useState } from 'react';
import type { HistoryData, HistorySessionSummary } from '../../types';
import VirtualList from './VirtualList';

interface HistoryViewProps {
  historyData: HistoryData | null;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void; // 添加删除回调
}

const formatTimeAgo = (timestamp?: string) => {
  if (!timestamp) {
    return '';
  }
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  const units: [number, string][] = [
    [31536000, '年前'],
    [2592000, '个月前'],
    [86400, '天前'],
    [3600, '小时前'],
    [60, '分钟前'],
  ];

  for (const [unitSeconds, label] of units) {
    const interval = Math.floor(seconds / unitSeconds);
    if (interval >= 1) {
      return `${interval} ${label}`;
    }
  }
  return `${Math.max(seconds, 1)} 秒前`;
};

const HistoryView = ({ historyData, onLoadSession, onDeleteSession }: HistoryViewProps) => {
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
    return `共 ${sessionCount} 个会话 · ${messageCount} 条消息`;
  }, [historyData, sessions.length]);

  if (!historyData) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📜</div>
          <div>加载历史记录中...</div>
        </div>
      </div>
    );
  }

  if (!historyData.success) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
          <div>{historyData.error ?? '加载失败'}</div>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📭</div>
          <div>暂无历史会话</div>
          <div style={{ fontSize: '12px', marginTop: '8px' }}>当前项目下没有找到 Claude 会话记录</div>
        </div>
      </div>
    );
  }

  // 处理删除按钮点击(阻止事件冒泡,避免触发会话加载)
  const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // 阻止点击事件冒泡到父元素
    setDeletingSessionId(sessionId); // 显示确认对话框
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
          <div className="history-item-time">{formatTimeAgo(session.lastTimestamp)}</div>
          {/* 删除按钮 */}
          <button
            className="history-delete-btn"
            onClick={(e) => handleDeleteClick(e, session.sessionId)}
            title="删除此会话"
            aria-label="删除会话"
          >
            <span className="codicon codicon-trash"></span>
          </button>
        </div>
      </div>
      <div className="history-item-meta">
        <span>{session.messageCount} 条消息</span>
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
            <h3>确认删除</h3>
            <p>确定要删除这个会话吗?此操作无法撤销。</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={cancelDelete}>
                取消
              </button>
              <button className="modal-btn modal-btn-danger" onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryView;

