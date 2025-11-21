package com.github.claudecodegui;

/**
 * 会话加载服务（单例）
 * 用于在"历史会话"和"Claude Code GUI"工具窗口之间传递会话加载请求
 */
public class SessionLoadService {

    private static final SessionLoadService INSTANCE = new SessionLoadService();

    private SessionLoadListener listener;
    private String pendingSessionId;
    private String pendingProjectPath;

    private SessionLoadService() {
    }

    public static SessionLoadService getInstance() {
        return INSTANCE;
    }

    /**
     * 会话加载监听器
     */
    public interface SessionLoadListener {
        void onLoadSessionRequest(String sessionId, String projectPath);
    }

    /**
     * 设置监听器（由 Claude Code GUI 窗口调用）
     */
    public void setListener(SessionLoadListener listener) {
        this.listener = listener;

        // 如果有待处理的加载请求，立即触发
        if (pendingSessionId != null && listener != null) {
            listener.onLoadSessionRequest(pendingSessionId, pendingProjectPath);
            pendingSessionId = null;
            pendingProjectPath = null;
        }
    }

    /**
     * 请求加载会话（由"历史会话"窗口调用）
     */
    public void requestLoadSession(String sessionId, String projectPath) {
        if (listener != null) {
            listener.onLoadSessionRequest(sessionId, projectPath);
        } else {
            // 如果监听器还未设置，保存待处理的请求
            pendingSessionId = sessionId;
            pendingProjectPath = projectPath;
        }
    }

    /**
     * 清除监听器
     */
    public void clearListener() {
        this.listener = null;
    }
}
