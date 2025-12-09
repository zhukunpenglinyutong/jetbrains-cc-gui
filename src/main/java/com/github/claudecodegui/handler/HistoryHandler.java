package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeHistoryReader;
import com.github.claudecodegui.util.JsUtils;

import javax.swing.*;
import java.util.concurrent.CompletableFuture;

/**
 * 历史数据处理器
 * 处理历史数据加载和会话加载
 */
public class HistoryHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
        "load_history_data",
        "load_session"
    };

    // 会话加载回调接口
    public interface SessionLoadCallback {
        void onLoadSession(String sessionId, String projectPath);
    }

    private SessionLoadCallback sessionLoadCallback;

    public HistoryHandler(HandlerContext context) {
        super(context);
    }

    public void setSessionLoadCallback(SessionLoadCallback callback) {
        this.sessionLoadCallback = callback;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "load_history_data":
                System.out.println("[HistoryHandler] 处理: load_history_data");
                handleLoadHistoryData();
                return true;
            case "load_session":
                System.out.println("[HistoryHandler] 处理: load_session");
                handleLoadSession(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 加载并注入历史数据到前端
     */
    private void handleLoadHistoryData() {
        CompletableFuture.runAsync(() -> {
            System.out.println("[HistoryHandler] ========== 开始加载历史数据 ==========");

            try {
                String projectPath = context.getProject().getBasePath();
                ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                String historyJson = historyReader.getProjectDataAsJson(projectPath);

                String escapedJson = escapeJs(historyJson);

                SwingUtilities.invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject history data');" +
                        "if (window.setHistoryData) { " +
                        "  try { " +
                        "    var jsonStr = '" + escapedJson + "'; " +
                        "    var data = JSON.parse(jsonStr); " +
                        "    window.setHistoryData(data); " +
                        "  } catch(e) { " +
                        "    console.error('[Backend->Frontend] Failed to parse/set history data:', e); " +
                        "    window.setHistoryData({ success: false, error: '解析历史数据失败: ' + e.message }); " +
                        "  } " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] setHistoryData not available!'); " +
                        "}";

                    context.executeJavaScriptOnEDT(jsCode);
                });

            } catch (Exception e) {
                System.err.println("[HistoryHandler] ❌ 加载历史数据失败: " + e.getMessage());
                e.printStackTrace();

                SwingUtilities.invokeLater(() -> {
                    String errorMsg = escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.setHistoryData) { " +
                        "  window.setHistoryData({ success: false, error: '" + errorMsg + "' }); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * 加载历史会话
     */
    private void handleLoadSession(String sessionId) {
        String projectPath = context.getProject().getBasePath();
        System.out.println("[HistoryHandler] Loading history session: " + sessionId + " from project: " + projectPath);

        if (sessionLoadCallback != null) {
            sessionLoadCallback.onLoadSession(sessionId, projectPath);
        } else {
            System.err.println("[HistoryHandler] WARNING: No session load callback set");
        }
    }
}
