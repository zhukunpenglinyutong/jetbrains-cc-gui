import { useEffect, useState } from 'react';
import type { ProjectStatistics, DailyUsage } from '../types/usage';

type TabType = 'overview' | 'models' | 'sessions' | 'timeline';
type ScopeType = 'current' | 'all';
type DateRangeType = '7d' | '30d' | 'all';

const sendToJava = (message: string, payload: any = {}) => {
  if (window.sendToJava) {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    window.sendToJava(`${message}:${payloadStr}`);
  }
};

const UsageStatisticsSection = () => {
  const [statistics, setStatistics] = useState<ProjectStatistics | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [projectScope, setProjectScope] = useState<ScopeType>('current');
  const [dateRange, setDateRange] = useState<DateRangeType>('30d');
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSortBy, setSessionSortBy] = useState<'cost' | 'time'>('cost');
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    content: { date: string; cost: number; sessions: number };
  }>({
    visible: false,
    x: 0,
    y: 0,
    content: { date: '', cost: 0, sessions: 0 }
  });
  const sessionsPerPage = 20;

  useEffect(() => {
    // 设置全局回调
    window.updateUsageStatistics = (jsonStr: string) => {
      try {
        const data: ProjectStatistics = JSON.parse(jsonStr);
        setStatistics(data);
        setLoading(false);
      } catch (error) {
        console.error('Failed to parse usage statistics:', error);
        setLoading(false);
      }
    };

    // 初始加载
    loadStatistics();

    return () => {
      window.updateUsageStatistics = undefined;
    };
  }, [projectScope]);

  const loadStatistics = () => {
    setLoading(true);
    sendToJava('get_usage_statistics', { scope: projectScope });
  };

  const handleRefresh = () => {
    loadStatistics();
  };

  const handleScopeChange = (scope: ScopeType) => {
    setProjectScope(scope);
    setSessionPage(1);
  };

  // 数字格式化
  const formatNumber = (num: number): string => {
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toString();
  };

  const formatCost = (cost: number): string => {
    return `$${cost.toFixed(4)}`;
  };

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays}天前`;

    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  // 中文日期格式化
  const formatChineseDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}月${day}日`;
  };

  // 相对时间格式化（用于最后更新时间）
  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    if (diffHour < 24) return `${diffHour}小时前`;

    return formatDate(timestamp);
  };

  // 趋势渲染函数
  const renderTrend = (value: number) => {
    if (value === 0) return <span className="trend neutral">→ 0% 较上周</span>;
    const isUp = value > 0;
    return (
      <span className={`trend ${isUp ? 'up' : 'down'}`}>
        {isUp ? '↑' : '↓'} {Math.abs(value).toFixed(1)}% 较上周
      </span>
    );
  };

  // 日期筛选函数
  const filterByDateRange = <T extends { timestamp?: number; date?: string }>(
    items: T[],
    range: DateRangeType
  ): T[] => {
    if (range === 'all') return items;

    const now = Date.now();
    const cutoff = range === '7d'
      ? now - 7 * 24 * 60 * 60 * 1000
      : now - 30 * 24 * 60 * 60 * 1000;

    return items.filter(item => {
      const time = item.timestamp || new Date(item.date!).getTime();
      return time >= cutoff;
    });
  };

  // 筛选和排序会话
  const filteredSessions = filterByDateRange(statistics?.sessions || [], dateRange).slice().sort((a, b) => {
    if (sessionSortBy === 'cost') {
      return b.cost - a.cost;
    } else {
      return b.timestamp - a.timestamp;
    }
  });

  const paginatedSessions = filteredSessions.slice(
    (sessionPage - 1) * sessionsPerPage,
    sessionPage * sessionsPerPage
  );

  const totalPages = Math.ceil(filteredSessions.length / sessionsPerPage);

  // 获取Token百分比
  const getTokenPercentage = (value: number): number => {
    if (!statistics || statistics.totalUsage.totalTokens === 0) return 0;
    return (value / statistics.totalUsage.totalTokens) * 100;
  };

  // 筛选日期范围内的数据
  const getFilteredDailyUsage = (): DailyUsage[] => {
    if (!statistics) return [];

    const now = Date.now();
    let cutoffDate = 0;

    if (dateRange === '7d') {
      cutoffDate = now - 7 * 24 * 60 * 60 * 1000;
    } else if (dateRange === '30d') {
      cutoffDate = now - 30 * 24 * 60 * 60 * 1000;
    }

    if (dateRange === 'all') {
      return statistics.dailyUsage;
    }

    return statistics.dailyUsage.filter(day => {
      const dayTime = new Date(day.date).getTime();
      return dayTime >= cutoffDate;
    });
  };

  const filteredDailyUsage = getFilteredDailyUsage();

  if (loading && !statistics) {
    return (
      <div className="usage-statistics-section">
        <div className="loading-container">
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>加载统计数据中...</p>
        </div>
      </div>
    );
  }

  if (!statistics) {
    return (
      <div className="usage-statistics-section">
        <div className="empty-container">
          <span className="codicon codicon-graph" />
          <p>暂无统计数据</p>
          <button onClick={handleRefresh} className="btn-primary">
            <span className="codicon codicon-refresh" />
            加载数据
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="usage-statistics-section">
      {/* 控制栏 */}
      <div className="usage-controls">
        <div className="controls-left">
          <div className="scope-selector">
            <button
              className={`scope-btn ${projectScope === 'current' ? 'active' : ''}`}
              onClick={() => handleScopeChange('current')}
            >
              <span className="codicon codicon-folder" />
              当前项目
            </button>
            <button
              className={`scope-btn ${projectScope === 'all' ? 'active' : ''}`}
              onClick={() => handleScopeChange('all')}
            >
              <span className="codicon codicon-folder-library" />
              所有项目
            </button>
          </div>

          <div className="date-range-selector">
            <button
              className={`range-btn ${dateRange === '7d' ? 'active' : ''}`}
              onClick={() => setDateRange('7d')}
            >
              最近7天
            </button>
            <button
              className={`range-btn ${dateRange === '30d' ? 'active' : ''}`}
              onClick={() => setDateRange('30d')}
            >
              最近30天
            </button>
            <button
              className={`range-btn ${dateRange === 'all' ? 'active' : ''}`}
              onClick={() => setDateRange('all')}
            >
              全部时间
            </button>
          </div>
        </div>

        <button onClick={handleRefresh} className="refresh-btn icon-only" disabled={loading} title="刷新数据">
          <span className={`codicon codicon-refresh ${loading ? 'codicon-modifier-spin' : ''}`} />
        </button>
      </div>

      {/* Tab导航 */}
      <div className="usage-tabs">
        <button
          className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <span className="codicon codicon-dashboard" />
          总览
        </button>
        <button
          className={`tab-btn ${activeTab === 'models' ? 'active' : ''}`}
          onClick={() => setActiveTab('models')}
        >
          <span className="codicon codicon-symbol-class" />
          模型
        </button>
        <button
          className={`tab-btn ${activeTab === 'sessions' ? 'active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          <span className="codicon codicon-list-unordered" />
          会话
        </button>
        <button
          className={`tab-btn ${activeTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          <span className="codicon codicon-graph-line" />
          趋势
        </button>
      </div>

      {/* Tab内容 */}
      <div className="usage-content">
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="overview-tab">
            {/* 项目信息 - 简化版 */}
            <div className="project-info-simple">
              <span className="codicon codicon-folder" />
              <span className="project-name">{statistics.projectName}</span>
            </div>

            {/* 统计卡片 - 带趋势指示器 */}
            <div className="stat-cards">
              <div className="stat-card cost-card">
                <div className="stat-icon">
                  <span className="codicon codicon-credit-card" />
                </div>
                <div className="stat-content">
                  <div className="stat-label">总消费</div>
                  <div className="stat-value">{formatCost(statistics.estimatedCost)}</div>
                  {statistics.weeklyComparison && renderTrend(statistics.weeklyComparison.trends.cost)}
                </div>
              </div>

              <div className="stat-card sessions-card">
                <div className="stat-icon">
                  <span className="codicon codicon-comment-discussion" />
                </div>
                <div className="stat-content">
                  <div className="stat-label">总会话数</div>
                  <div className="stat-value">{statistics.totalSessions}</div>
                  {statistics.weeklyComparison && renderTrend(statistics.weeklyComparison.trends.sessions)}
                </div>
              </div>

              <div className="stat-card tokens-card">
                <div className="stat-icon">
                  <span className="codicon codicon-symbol-numeric" />
                </div>
                <div className="stat-content">
                  <div className="stat-label">总Token数</div>
                  <div className="stat-value">{formatNumber(statistics.totalUsage.totalTokens)}</div>
                  {statistics.weeklyComparison && renderTrend(statistics.weeklyComparison.trends.tokens)}
                </div>
              </div>

              <div className="stat-card avg-card">
                <div className="stat-icon">
                  <span className="codicon codicon-graph" />
                </div>
                <div className="stat-content">
                  <div className="stat-label">平均/会话</div>
                  <div className="stat-value">
                    {statistics.totalSessions > 0
                      ? formatCost(statistics.estimatedCost / statistics.totalSessions)
                      : '$0.00'}
                  </div>
                </div>
              </div>
            </div>

            {/* Token分解 - 独立进度条形式 */}
            <div className="token-breakdown-section">
              <h4>Token 分解</h4>
              <div className="token-breakdown-independent">
                <div className="token-bar-item">
                  <div className="token-bar-header">
                    <span className="token-bar-label">输入</span>
                    <span className="token-bar-value">{formatNumber(statistics.totalUsage.inputTokens)}</span>
                  </div>
                  <div className="token-bar-track">
                    <div
                      className="token-bar-fill input"
                      style={{ width: `${getTokenPercentage(statistics.totalUsage.inputTokens)}%` }}
                    />
                  </div>
                </div>

                <div className="token-bar-item">
                  <div className="token-bar-header">
                    <span className="token-bar-label">输出</span>
                    <span className="token-bar-value">{formatNumber(statistics.totalUsage.outputTokens)}</span>
                  </div>
                  <div className="token-bar-track">
                    <div
                      className="token-bar-fill output"
                      style={{ width: `${getTokenPercentage(statistics.totalUsage.outputTokens)}%` }}
                    />
                  </div>
                </div>

                <div className="token-bar-item">
                  <div className="token-bar-header">
                    <span className="token-bar-label">缓存写入</span>
                    <span className="token-bar-value">{formatNumber(statistics.totalUsage.cacheWriteTokens)}</span>
                  </div>
                  <div className="token-bar-track">
                    <div
                      className="token-bar-fill cache-write"
                      style={{ width: `${getTokenPercentage(statistics.totalUsage.cacheWriteTokens)}%` }}
                    />
                  </div>
                </div>

                <div className="token-bar-item">
                  <div className="token-bar-header">
                    <span className="token-bar-label">缓存读取</span>
                    <span className="token-bar-value">{formatNumber(statistics.totalUsage.cacheReadTokens)}</span>
                  </div>
                  <div className="token-bar-track">
                    <div
                      className="token-bar-fill cache-read"
                      style={{ width: `${getTokenPercentage(statistics.totalUsage.cacheReadTokens)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Top模型 */}
            {statistics.byModel.length > 0 && (
              <div className="top-models-section">
                <h4>最常用模型</h4>
                <div className="top-models">
                  {statistics.byModel.slice(0, 3).map((model, index) => (
                    <div key={model.model} className="model-card">
                      <div className="model-rank">#{index + 1}</div>
                      <div className="model-info">
                        <div className="model-name">{model.model}</div>
                        <div className="model-stats">
                          <span>{formatCost(model.totalCost)}</span>
                          <span className="separator">•</span>
                          <span>{formatNumber(model.totalTokens)} tokens</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Models Tab */}
        {activeTab === 'models' && (
          <div className="models-tab">
            <h4>按模型统计</h4>
            <div className="models-list">
              {statistics.byModel.map((model) => (
                <div key={model.model} className="model-item">
                  <div className="model-header">
                    <span className="model-name">{model.model}</span>
                    <span className="model-cost">{formatCost(model.totalCost)}</span>
                  </div>
                  <div className="model-details">
                    <div className="detail-item">
                      <span className="detail-label">会话数:</span>
                      <span className="detail-value">{model.sessionCount}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">总Token:</span>
                      <span className="detail-value">{formatNumber(model.totalTokens)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">输入:</span>
                      <span className="detail-value">{formatNumber(model.inputTokens)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">输出:</span>
                      <span className="detail-value">{formatNumber(model.outputTokens)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sessions Tab */}
        {activeTab === 'sessions' && (
          <div className="sessions-tab">
            <div className="sessions-header">
              <h4>会话列表 ({filteredSessions.length})</h4>
              <div className="sort-buttons">
                <button
                  className={`sort-btn ${sessionSortBy === 'cost' ? 'active' : ''}`}
                  onClick={() => setSessionSortBy('cost')}
                >
                  按消费
                </button>
                <button
                  className={`sort-btn ${sessionSortBy === 'time' ? 'active' : ''}`}
                  onClick={() => setSessionSortBy('time')}
                >
                  按时间
                </button>
              </div>
            </div>

            <div className="sessions-list">
              {paginatedSessions.map((session, index) => (
                <div key={session.sessionId} className="session-item">
                  <div className="session-rank">
                    {(sessionPage - 1) * sessionsPerPage + index + 1}
                  </div>
                  <div className="session-info">
                    {/* 优先显示 summary 作为标题 */}
                    <div className="session-title">
                      {session.summary || session.sessionId}
                    </div>
                    {session.summary && (
                      <div className="session-id-small">{session.sessionId}</div>
                    )}
                    <div className="session-meta">
                      <span>{formatDate(session.timestamp)}</span>
                      <span className="separator">•</span>
                      <span>{session.model}</span>
                      <span className="separator">•</span>
                      <span>{formatNumber(session.usage.totalTokens)} tokens</span>
                    </div>
                  </div>
                  <div className="session-cost">{formatCost(session.cost)}</div>
                </div>
              ))}
            </div>

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="pagination">
                <button
                  onClick={() => setSessionPage(p => Math.max(1, p - 1))}
                  disabled={sessionPage === 1}
                  className="page-btn"
                >
                  <span className="codicon codicon-chevron-left" />
                </button>
                <span className="page-info">
                  {sessionPage} / {totalPages}
                </span>
                <button
                  onClick={() => setSessionPage(p => Math.min(totalPages, p + 1))}
                  disabled={sessionPage === totalPages}
                  className="page-btn"
                >
                  <span className="codicon codicon-chevron-right" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Timeline Tab */}
        {activeTab === 'timeline' && (
          <div className="timeline-tab">
            <h4>每日使用趋势</h4>
            <div className="timeline-chart">
              {filteredDailyUsage.length > 0 ? (
                (() => {
                  const maxCost = Math.max(...filteredDailyUsage.map(d => d.cost));
                  const yAxisValues = [0, maxCost * 0.25, maxCost * 0.5, maxCost * 0.75, maxCost];

                  return (
                    <div className="chart-with-axis">
                      {/* Y轴标签 */}
                      <div className="chart-y-axis">
                        {yAxisValues.reverse().map((val, i) => (
                          <div key={i} className="y-axis-label">
                            {formatCost(val)}
                          </div>
                        ))}
                      </div>

                      {/* 图表主体 */}
                      <div className="chart-main">
                        {/* 网格线 */}
                        <div className="chart-grid">
                          {[0, 1, 2, 3, 4].map(i => (
                            <div key={i} className="chart-grid-line" style={{ bottom: `${i * 25}%` }} />
                          ))}
                        </div>

                        {/* 柱状图 */}
                        <div className="chart-bars">
                          {filteredDailyUsage.map((day) => {
                            const height = maxCost > 0 ? (day.cost / maxCost) * 100 : 0;
                            return (
                              <div key={day.date} className="chart-bar-wrapper">
                                <div className="chart-bar-container">
                                  <div
                                    className="chart-bar"
                                    style={{ height: `${height}%` }}
                                    onMouseEnter={(e) => {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      setTooltip({
                                        visible: true,
                                        x: rect.left + rect.width / 2,
                                        y: rect.top,
                                        content: { date: day.date, cost: day.cost, sessions: day.sessions }
                                      });
                                    }}
                                    onMouseLeave={() => setTooltip(prev => ({ ...prev, visible: false }))}
                                  />
                                </div>
                                <div className="chart-label">{formatChineseDate(day.date)}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div className="empty-timeline">
                  <span className="codicon codicon-info" />
                  <p>该时间范围内暂无数据</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 自定义 Tooltip */}
      {tooltip.visible && (
        <div
          className="chart-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="tooltip-date">{formatChineseDate(tooltip.content.date)}</div>
          <div className="tooltip-cost">{formatCost(tooltip.content.cost)}</div>
          <div className="tooltip-sessions">{tooltip.content.sessions} 次会话</div>
        </div>
      )}

      {/* 最后更新时间 */}
      {statistics.lastUpdated && (
        <div className="last-updated">
          <span className="codicon codicon-sync" />
          <span>最后更新: {formatRelativeTime(statistics.lastUpdated)}</span>
        </div>
      )}
    </div>
  );
};

export default UsageStatisticsSection;
