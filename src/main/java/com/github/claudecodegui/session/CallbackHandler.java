package com.github.claudecodegui.session;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.permission.PermissionRequest;

import java.util.List;

/**
 * 回调处理器
 * 负责处理会话的各种回调通知
 */
public class CallbackHandler {
    private ClaudeSession.SessionCallback callback;

    public void setCallback(ClaudeSession.SessionCallback callback) {
        this.callback = callback;
    }

    /**
     * 通知消息更新
     */
    public void notifyMessageUpdate(List<ClaudeSession.Message> messages) {
        if (callback != null) {
            callback.onMessageUpdate(messages);
        }
    }

    /**
     * 通知状态更新
     */
    public void notifyStateChange(boolean busy, boolean loading, String error) {
        if (callback != null) {
            callback.onStateChange(busy, loading, error);
        }
    }

    /**
     * 通知会话ID接收
     */
    public void notifySessionIdReceived(String sessionId) {
        if (callback != null) {
            callback.onSessionIdReceived(sessionId);
        }
    }

    /**
     * 通知权限请求
     */
    public void notifyPermissionRequested(PermissionRequest request) {
        if (callback != null) {
            callback.onPermissionRequested(request);
        }
    }

    /**
     * 通知思考状态变化
     */
    public void notifyThinkingStatusChanged(boolean isThinking) {
        if (callback != null) {
            callback.onThinkingStatusChanged(isThinking);
        }
    }

    /**
     * 通知斜杠命令接收
     */
    public void notifySlashCommandsReceived(List<String> slashCommands) {
        if (callback != null) {
            callback.onSlashCommandsReceived(slashCommands);
        }
    }
}
