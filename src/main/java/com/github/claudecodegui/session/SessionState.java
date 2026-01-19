package com.github.claudecodegui.session;

import com.github.claudecodegui.ClaudeSession;

import java.util.ArrayList;
import java.util.List;

/**
 * 会话状态管理
 * 负责维护会话的所有状态信息
 */
public class SessionState {
    // 会话标识
    private String sessionId;
    private String channelId;

    // 会话状态
    private boolean busy = false;
    private boolean loading = false;
    private String error = null;

    // 消息历史
    private final List<ClaudeSession.Message> messages = new ArrayList<>();

    // 会话元数据
    private String summary = null;
    private long lastModifiedTime = System.currentTimeMillis();
    private String cwd = null;

    // 配置
    // 默认使用 bypassPermissions 与前端保持一致，确保 Codex 模式下有写入权限
    private String permissionMode = "bypassPermissions";
    private String model = "claude-sonnet-4-5";
    private String provider = "claude";
    // Codex reasoning effort (思考深度)
    private String reasoningEffort = "medium";

    // 斜杠命令
    private List<String> slashCommands = new ArrayList<>();

    // PSI上下文收集开关
    private boolean psiContextEnabled = true;

    // Getters
    public String getSessionId() {
        return sessionId;
    }

    public String getChannelId() {
        return channelId;
    }

    public boolean isBusy() {
        return busy;
    }

    public boolean isLoading() {
        return loading;
    }

    public String getError() {
        return error;
    }

    public List<ClaudeSession.Message> getMessages() {
        return new ArrayList<>(messages);
    }

    public List<ClaudeSession.Message> getMessagesReference() {
        return messages;
    }

    public String getSummary() {
        return summary;
    }

    public long getLastModifiedTime() {
        return lastModifiedTime;
    }

    public String getCwd() {
        return cwd;
    }

    public String getPermissionMode() {
        return permissionMode;
    }

    public String getModel() {
        return model;
    }

    public String getProvider() {
        return provider;
    }

    public String getReasoningEffort() {
        return reasoningEffort;
    }

    public List<String> getSlashCommands() {
        return new ArrayList<>(slashCommands);
    }



    public boolean isPsiContextEnabled() {
        return psiContextEnabled;
    }

    // Setters
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    public void setChannelId(String channelId) {
        this.channelId = channelId;
    }

    public void setBusy(boolean busy) {
        this.busy = busy;
    }

    public void setLoading(boolean loading) {
        this.loading = loading;
    }

    public void setError(String error) {
        this.error = error;
    }

    public void setSummary(String summary) {
        this.summary = summary;
    }

    public void setLastModifiedTime(long lastModifiedTime) {
        this.lastModifiedTime = lastModifiedTime;
    }

    public void setCwd(String cwd) {
        this.cwd = cwd;
    }

    public void setPermissionMode(String permissionMode) {
        this.permissionMode = permissionMode;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public void setReasoningEffort(String reasoningEffort) {
        this.reasoningEffort = reasoningEffort;
    }

    public void setSlashCommands(List<String> slashCommands) {
        this.slashCommands = new ArrayList<>(slashCommands);
    }



    public void setPsiContextEnabled(boolean psiContextEnabled) {
        this.psiContextEnabled = psiContextEnabled;
    }

    /**
     * 添加消息
     */
    public void addMessage(ClaudeSession.Message message) {
        messages.add(message);
    }

    /**
     * 清空消息
     */
    public void clearMessages() {
        messages.clear();
    }

    /**
     * 更新最后修改时间为当前时间
     */
    public void updateLastModifiedTime() {
        this.lastModifiedTime = System.currentTimeMillis();
    }
}
