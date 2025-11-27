package com.github.claudecodegui;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefJSQuery;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.github.claudecodegui.permission.PermissionDialog;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import javax.swing.*;
import java.awt.*;
import java.util.List;
import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Claude SDK 聊天工具窗口
 */
public class ClaudeSDKToolWindow implements ToolWindowFactory {

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        ClaudeChatWindow chatWindow = new ClaudeChatWindow(project);
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(
            chatWindow.getContent(),
            "Claude Claude",
            false
        );
        toolWindow.getContentManager().addContent(content);
    }

    /**
     * 聊天窗口内部类
     */
    private static class ClaudeChatWindow {
        private final JPanel mainPanel;
        private final ClaudeSDKBridge sdkBridge;
        private final Project project;
        private JBCefBrowser browser;
        private ClaudeSession session; // 添加 Session 管理
        private ToolInterceptor toolInterceptor; // 工具拦截器
        private CCSwitchSettingsService settingsService; // 配置服务
        private String currentModel = "claude-sonnet-4-5";
        private static final java.util.Map<String, Integer> MODEL_CONTEXT_LIMITS = new java.util.HashMap<>();
        static {
            MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-5", 200_000);
            MODEL_CONTEXT_LIMITS.put("claude-opus-4-5-20251101", 200_000);
        }

        public ClaudeChatWindow(Project project) {
            this.project = project;
            this.sdkBridge = new ClaudeSDKBridge();
            this.session = new ClaudeSession(sdkBridge); // 创建新会话
            this.toolInterceptor = new ToolInterceptor(project); // 创建工具拦截器
            this.settingsService = new CCSwitchSettingsService(); // 创建配置服务
            try {
                this.settingsService.applyActiveProviderToClaudeSettings();
            } catch (Exception e) {
                System.err.println("[ClaudeChatWindow] Failed to sync active provider on startup: " + e.getMessage());
            }
            this.mainPanel = new JPanel(new BorderLayout());

            // 启动权限服务
            PermissionService permissionService = PermissionService.getInstance(project);
            permissionService.start();
            permissionService.setDecisionListener(decision -> {
                if (decision != null &&
                    decision.getResponse() == PermissionService.PermissionResponse.DENY) {
                    interruptDueToPermissionDenial();
                }
            });
            System.out.println("[ClaudeChatWindow] Started permission service");

            // 先设置回调，再初始化会话信息
            setupSessionCallbacks();

            // 初始化会话，确保 cwd 正确设置
            String workingDirectory = determineWorkingDirectory();
            // sessionId 设置为 null，让 SDK 自动生成
            // cwd 设置为合适的工作目录
            this.session.setSessionInfo(null, workingDirectory);
            System.out.println("[ClaudeChatWindow] Initialized with working directory: " + workingDirectory);

            createUIComponents();
            registerSessionLoadListener(); // 注册会话加载监听器
        }

        private void createUIComponents() {
            // 首先检查环境
            if (!sdkBridge.checkEnvironment()) {
                showErrorPanel("环境检查失败",
                    "无法找到 Node.js 或 claude-bridge 目录。\n\n" +
                    "请确保:\n" +
                    "1. Node.js 已安装 (运行: node --version)\n" +
                    "2. claude-bridge 目录存在\n" +
                    "3. 已运行: cd claude-bridge && npm install\n\n" +
                    "Node.js 路径: " + sdkBridge.getNodeExecutable());
                return;
            }

            try {
                browser = new JBCefBrowser();

                // 创建 JavaScript 桥接
                JBCefJSQuery jsQuery = JBCefJSQuery.create((JBCefBrowser) browser);

                // 处理来自 JavaScript 的消息
                jsQuery.addHandler((msg) -> {
                    handleJavaScriptMessage(msg);
                    return new JBCefJSQuery.Response("ok");
                });

                // 生成 HTML 内容
                String htmlContent = generateChatHTML(jsQuery);

                // 加载完成后注入 Java 桥接函数
                browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                    @Override
                    public void onLoadEnd(CefBrowser browser, CefFrame frame, int httpStatusCode) {
                        // 注入 Java 调用函数
                        String injection = "window.sendToJava = function(msg) { " +
                            jsQuery.inject("msg") +
                            " };";
                        browser.executeJavaScript(injection, browser.getURL(), 0);
                    }
                }, browser.getCefBrowser());

                // 加载 HTML
                browser.loadHTML(htmlContent);

                mainPanel.add(browser.getComponent(), BorderLayout.CENTER);

            } catch (Exception e) {
                // 备用显示
                e.printStackTrace();
                showErrorPanel("无法加载聊天界面",
                    e.getMessage() + "\n\n" +
                    "请确保:\n" +
                    "1. Node.js 已安装 (运行: node --version)\n" +
                    "2. claude-bridge 目录存在\n" +
                    "3. 已运行: cd claude-bridge && npm install\n\n" +
                    "检测到的 Node.js 路径: " + sdkBridge.getNodeExecutable());
            }
        }

        /**
         * 显示错误面板
         */
        private void showErrorPanel(String title, String message) {
            JPanel errorPanel = new JPanel(new BorderLayout());
            errorPanel.setBackground(new Color(30, 30, 30));

            JLabel titleLabel = new JLabel(title);
            titleLabel.setFont(new Font("SansSerif", Font.BOLD, 16));
            titleLabel.setForeground(Color.WHITE);
            titleLabel.setBorder(BorderFactory.createEmptyBorder(20, 20, 10, 20));

            JTextArea textArea = new JTextArea(message);
            textArea.setEditable(false);
            textArea.setFont(new Font("Monospaced", Font.PLAIN, 12));
            textArea.setBackground(new Color(40, 40, 40));
            textArea.setForeground(new Color(220, 220, 220));
            textArea.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
            textArea.setLineWrap(true);
            textArea.setWrapStyleWord(true);

            errorPanel.add(titleLabel, BorderLayout.NORTH);
            errorPanel.add(new JScrollPane(textArea), BorderLayout.CENTER);

            mainPanel.add(errorPanel, BorderLayout.CENTER);
        }

        /**
         * 处理来自 JavaScript 的消息
         */
        private void handleJavaScriptMessage(String message) {
            System.out.println("[Backend] ========== 收到 JS 消息 ==========");
            System.out.println("[Backend] 原始消息: " + message);

            // 解析消息（简单的格式：type:content）
            String[] parts = message.split(":", 2);
            if (parts.length < 1) {
                System.err.println("[Backend] 错误: 消息格式无效");
                return;
            }

            String type = parts[0];
            String content = parts.length > 1 ? parts[1] : "";
            System.out.println("[Backend] 消息类型: '" + type + "'");
            System.out.println("[Backend] 消息内容: '" + content + "'");

            switch (type) {
                case "send_message":
                    System.out.println("[Backend] 处理: send_message");
                    sendMessageToClaude(content);
                    break;

                case "send_message_with_attachments":
                    System.out.println("[Backend] 处理: send_message_with_attachments");
                    try {
                        com.google.gson.Gson gson = new com.google.gson.Gson();
                        com.google.gson.JsonObject payload = gson.fromJson(content, com.google.gson.JsonObject.class);
                        String text = payload != null && payload.has("text") && !payload.get("text").isJsonNull()
                            ? payload.get("text").getAsString()
                            : "";
                        java.util.List<com.github.claudecodegui.ClaudeSession.Attachment> atts = new java.util.ArrayList<>();
                        if (payload != null && payload.has("attachments") && payload.get("attachments").isJsonArray()) {
                            com.google.gson.JsonArray arr = payload.getAsJsonArray("attachments");
                            for (int i = 0; i < arr.size(); i++) {
                                com.google.gson.JsonObject a = arr.get(i).getAsJsonObject();
                                String fileName = a.has("fileName") && !a.get("fileName").isJsonNull() ? a.get("fileName").getAsString() : ("attachment-" + System.currentTimeMillis());
                                String mediaType = a.has("mediaType") && !a.get("mediaType").isJsonNull() ? a.get("mediaType").getAsString() : "application/octet-stream";
                                String data = a.has("data") && !a.get("data").isJsonNull() ? a.get("data").getAsString() : "";
                                atts.add(new com.github.claudecodegui.ClaudeSession.Attachment(fileName, mediaType, data));
                            }
                        }
                        sendMessageToClaudeWithAttachments(text, atts);
                    } catch (Exception e) {
                        System.err.println("[Backend] 解析附件负载失败: " + e.getMessage());
                        sendMessageToClaude(content);
                    }
                    break;

                case "interrupt_session":
                    System.out.println("[Backend] 处理: interrupt_session");
                    session.interrupt().thenRun(() -> {
                        SwingUtilities.invokeLater(() -> {
                            callJavaScript("updateStatus", escapeJs("会话已中断"));
                        });
                    });
                    break;

                case "restart_session":
                    System.out.println("[Backend] 处理: restart_session");
                    session.restart().thenRun(() -> {
                        SwingUtilities.invokeLater(() -> {
                            callJavaScript("updateStatus", escapeJs("会话已重启"));
                        });
                    });
                    break;

                case "create_new_session":
                    System.out.println("[Backend] 处理: create_new_session");
                    createNewSession();
                    break;

                case "open_file":
                    System.out.println("[Backend] 处理: open_file");
                    openFileInEditor(content);
                    break;

                case "open_browser":
                    System.out.println("[Backend] 处理: open_browser");
                    openBrowser(content);
                    break;

                case "permission_decision":
                    System.out.println("[Backend] 处理: permission_decision");
                    handlePermissionDecision(content);
                    break;

                case "load_history_data":
                    System.out.println("[Backend] 处理: load_history_data");
                    loadAndInjectHistoryData();
                    break;

                case "load_session":
                    System.out.println("[Backend] 处理: load_session");
                    loadHistorySession(content, project.getBasePath());
                    break;

                case "get_providers":
                    System.out.println("[Backend] 处理: get_providers");
                    handleGetProviders();
                    break;

                case "add_provider":
                    System.out.println("[Backend] 处理: add_provider");
                    handleAddProvider(content);
                    break;

                case "update_provider":
                    System.out.println("[Backend] 处理: update_provider");
                    handleUpdateProvider(content);
                    break;

                case "delete_provider":
                    System.out.println("[Backend] 处理: delete_provider");
                    handleDeleteProvider(content);
                    break;

                case "switch_provider":
                    System.out.println("[Backend] 处理: switch_provider");
                    handleSwitchProvider(content);
                    break;

                case "get_active_provider":
                    System.out.println("[Backend] 处理: get_active_provider");
                    handleGetActiveProvider();
                    break;

                case "get_usage_statistics":
                    System.out.println("[Backend] 处理: get_usage_statistics");
                    handleGetUsageStatistics(content);
                    break;

                case "list_files":
                    System.out.println("[Backend] 处理: list_files");
                    handleListFiles(content);
                    break;

                case "get_commands":
                    System.out.println("[Backend] 处理: get_commands");
                    handleGetCommands(content);
                    break;

                case "set_mode":
                    System.out.println("[Backend] 处理: set_mode");
                    handleSetMode(content);
                    break;

                case "set_model":
                    System.out.println("[Backend] 处理: set_model");
                    handleSetModel(content);
                    break;

                default:
                    System.err.println("[Backend] 警告: 未知的消息类型: " + type);
            }
            System.out.println("[Backend] ========== 消息处理完成 ==========");
        }

        /**
         * 注册会话加载监听器
         */
        private void registerSessionLoadListener() {
            SessionLoadService.getInstance().setListener((sessionId, projectPath) -> {
                SwingUtilities.invokeLater(() -> {
                    loadHistorySession(sessionId, projectPath);
                });
            });
        }

        /**
         * 确定合适的工作目录
         * 优先级：
         * 1. 当前打开文件的目录
         * 2. 项目根目录
         * 3. 用户主目录
         */
        private String determineWorkingDirectory() {
            // 1. 尝试获取当前打开文件的目录
            try {
                FileEditorManager editorManager = FileEditorManager.getInstance(project);
                VirtualFile[] openFiles = editorManager.getOpenFiles();
                if (openFiles != null && openFiles.length > 0) {
                    VirtualFile currentFile = editorManager.getSelectedFiles()[0];
                    if (currentFile != null && currentFile.getParent() != null) {
                        String currentFileDir = currentFile.getParent().getPath();
                        System.out.println("[ClaudeChatWindow] Using current file directory: " + currentFileDir);
                        return currentFileDir;
                    }
                }
            } catch (Exception e) {
                System.err.println("[ClaudeChatWindow] Failed to get current file directory: " + e.getMessage());
            }

            // 2. 尝试使用项目根目录
            String projectPath = project.getBasePath();
            if (projectPath != null && new File(projectPath).exists()) {
                System.out.println("[ClaudeChatWindow] Using project base path: " + projectPath);
                return projectPath;
            }

            // 3. 最后使用用户主目录
            String userHome = System.getProperty("user.home");
            System.out.println("[ClaudeChatWindow] WARNING: Using user home directory as fallback: " + userHome);
            System.out.println("[ClaudeChatWindow] Files will be written to: " + userHome);

            // 显示警告
            SwingUtilities.invokeLater(() -> {
                callJavaScript("updateStatus", escapeJs("警告: 工作目录设置为 " + userHome));
            });

            return userHome;
        }

        /**
         * 加载并注入历史数据到前端
         */
        private void loadAndInjectHistoryData() {
            System.out.println("[Backend] ========== 开始加载历史数据 ==========");

            try {
                String projectPath = project.getBasePath();
                System.out.println("[Backend] 项目路径: " + projectPath);

                ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                System.out.println("[Backend] 创建 ClaudeHistoryReader 成功");

                String historyJson = historyReader.getProjectDataAsJson(projectPath);
                System.out.println("[Backend] 读取历史数据成功");
                System.out.println("[Backend] JSON 长度: " + historyJson.length());
                System.out.println("[Backend] JSON 预览 (前200字符): " + historyJson.substring(0, Math.min(200, historyJson.length())));

                // 转义 JSON 字符串
                String escapedJson = escapeJs(historyJson);
                System.out.println("[Backend] JSON 转义成功，转义后长度: " + escapedJson.length());

                // 调用 JavaScript 函数设置历史数据
                SwingUtilities.invokeLater(() -> {
                    System.out.println("[Backend] 准备执行 JavaScript 注入...");
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject history data');" +
                        "if (window.setHistoryData) { " +
                        "  console.log('[Backend->Frontend] setHistoryData is available'); " +
                        "  try { " +
                        "    var jsonStr = '" + escapedJson + "'; " +
                        "    console.log('[Backend->Frontend] JSON string length:', jsonStr.length); " +
                        "    var data = JSON.parse(jsonStr); " +
                        "    console.log('[Backend->Frontend] JSON parsed successfully:', data); " +
                        "    window.setHistoryData(data); " +
                        "    console.log('[Backend->Frontend] setHistoryData called'); " +
                        "  } catch(e) { " +
                        "    console.error('[Backend->Frontend] Failed to parse/set history data:', e); " +
                        "    console.error('[Backend->Frontend] Error message:', e.message); " +
                        "    console.error('[Backend->Frontend] Error stack:', e.stack); " +
                        "    window.setHistoryData({ success: false, error: '解析历史数据失败: ' + e.message }); " +
                        "  } " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] setHistoryData not available!'); " +
                        "  console.log('[Backend->Frontend] Available window properties:', Object.keys(window).filter(k => k.includes('set') || k.includes('History'))); " +
                        "}";

                    System.out.println("[Backend] 执行 JavaScript 代码");
                    browser.getCefBrowser().executeJavaScript(jsCode, browser.getCefBrowser().getURL(), 0);
                    System.out.println("[Backend] JavaScript 代码已提交执行");
                });

            } catch (Exception e) {
                System.err.println("[Backend] ❌ 加载历史数据失败!");
                System.err.println("[Backend] 错误信息: " + e.getMessage());
                System.err.println("[Backend] 错误堆栈:");
                e.printStackTrace();

                // 发送错误信息到前端
                SwingUtilities.invokeLater(() -> {
                    String errorMsg = escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "console.error('[Backend->Frontend] Error from backend:', '" + errorMsg + "'); " +
                        "if (window.setHistoryData) { " +
                        "  window.setHistoryData({ success: false, error: '" + errorMsg + "' }); " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] Cannot report error - setHistoryData not available'); " +
                        "}";
                    browser.getCefBrowser().executeJavaScript(jsCode, browser.getCefBrowser().getURL(), 0);
                });
            }

            System.out.println("[Backend] ========== 历史数据加载流程结束 ==========");
        }

        /**
         * 加载历史会话
         */
        private void loadHistorySession(String sessionId, String projectPath) {
            System.out.println("Loading history session: " + sessionId + " from project: " + projectPath);

            // 清空当前消息
            callJavaScript("clearMessages");

            // 更新状态
            callJavaScript("updateStatus", escapeJs("正在加载历史会话..."));

            // 创建新的 Session 并设置会话信息
            session = new ClaudeSession(sdkBridge);
            setupSessionCallbacks();

            // 如果历史会话没有projectPath或无效，使用智能方法确定
            String workingDir = projectPath;
            if (workingDir == null || !new File(workingDir).exists()) {
                workingDir = determineWorkingDirectory();
                System.out.println("[ClaudeChatWindow] Historical projectPath invalid, using: " + workingDir);
            }
            session.setSessionInfo(sessionId, workingDir);

            // 从服务器加载会话消息
            session.loadFromServer().thenRun(() -> {
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("updateStatus", escapeJs("会话已加载，可以继续提问"));
                });
            }).exceptionally(ex -> {
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("addErrorMessage", escapeJs("加载会话失败: " + ex.getMessage()));
                    callJavaScript("updateStatus", escapeJs("加载失败"));
                });
                return null;
            });
        }

        /**
         * 设置会话回调
         */
        private void setupSessionCallbacks() {
            session.setCallback(new ClaudeSession.SessionCallback() {
                @Override
                public void onMessageUpdate(List<ClaudeSession.Message> messages) {
                    System.out.println("[ClaudeChatWindow] onMessageUpdate called with " + messages.size() + " messages");
                    SwingUtilities.invokeLater(() -> {
                        // 将消息列表转换为 JSON
                        com.google.gson.Gson gson = new com.google.gson.Gson();
                        com.google.gson.JsonArray messagesArray = new com.google.gson.JsonArray();

                        for (ClaudeSession.Message msg : messages) {
                            com.google.gson.JsonObject msgObj = new com.google.gson.JsonObject();
                            msgObj.addProperty("type", msg.type.toString().toLowerCase());
                            msgObj.addProperty("timestamp", msg.timestamp);

                            // 始终传递 content 作为 fallback
                            msgObj.addProperty("content", msg.content != null ? msg.content : "");

                            // 如果有原始数据，也传递它
                            if (msg.raw != null) {
                                msgObj.add("raw", msg.raw);
                            }

                            messagesArray.add(msgObj);
                            System.out.println("[ClaudeChatWindow] Message: type=" + msg.type +
                                ", content.length=" + (msg.content != null ? msg.content.length() : 0) +
                                ", hasRaw=" + (msg.raw != null));
                        }

                        String messagesJson = gson.toJson(messagesArray);
                        String escapedJson = escapeJs(messagesJson);

                        // 调用 JavaScript 更新消息
                    callJavaScript("updateMessages", escapedJson);
                });
                System.out.println("[Backend] Pushing usage update from messages (real-time), messageCount=" + messages.size());
                pushUsageUpdateFromMessages(messages);
            }

                @Override
                public void onStateChange(boolean busy, boolean loading, String error) {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("showLoading", String.valueOf(busy));

                        if (error != null) {
                            callJavaScript("updateStatus", escapeJs("错误: " + error));
                        } else if (busy) {
                            callJavaScript("updateStatus", escapeJs("正在处理..."));
                        } else if (loading) {
                            callJavaScript("updateStatus", escapeJs("加载中..."));
                        } else {
                            callJavaScript("updateStatus", escapeJs("就绪"));
                        }
                    });
                }

                @Override
                public void onSessionIdReceived(String sessionId) {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("updateStatus", escapeJs("会话 ID: " + sessionId));
                        System.out.println("Session ID: " + sessionId);
                    });
                }

                @Override
                public void onPermissionRequested(PermissionRequest request) {
                    SwingUtilities.invokeLater(() -> {
                        showPermissionDialog(request);
                    });
                }
            });
        }

        private void pushUsageUpdateFromMessages(java.util.List<ClaudeSession.Message> messages) {
            try {
                com.google.gson.JsonObject lastUsage = null;
                for (int i = messages.size() - 1; i >= 0; i--) {
                    ClaudeSession.Message msg = messages.get(i);
                    if (msg.type != ClaudeSession.Message.Type.ASSISTANT) continue;
                    if (msg.raw == null) continue;
                    if (!msg.raw.has("message")) continue;
                    com.google.gson.JsonObject message = msg.raw.getAsJsonObject("message");
                    if (!message.has("usage")) continue;
                    lastUsage = message.getAsJsonObject("usage");
                    break;
                }

                int inputTokens = 0;
                int outputTokens = 0;
                int cacheWriteTokens = 0;
                int cacheReadTokens = 0;
                if (lastUsage != null) {
                    inputTokens = lastUsage.has("input_tokens") ? lastUsage.get("input_tokens").getAsInt() : 0;
                    outputTokens = lastUsage.has("output_tokens") ? lastUsage.get("output_tokens").getAsInt() : 0;
                    cacheWriteTokens = lastUsage.has("cache_creation_input_tokens") ? lastUsage.get("cache_creation_input_tokens").getAsInt() : 0;
                    cacheReadTokens = lastUsage.has("cache_read_input_tokens") ? lastUsage.get("cache_read_input_tokens").getAsInt() : 0;
                    System.out.println("[Backend] Last assistant usage -> input:" + inputTokens + ", output:" + outputTokens + ", cacheWrite:" + cacheWriteTokens + ", cacheRead:" + cacheReadTokens);
                }

                int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
                int maxTokens = MODEL_CONTEXT_LIMITS.getOrDefault(currentModel, 200_000);
                int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);
                System.out.println("[Backend] 上下文=" + usedTokens + ", maxContext=" + maxTokens + ", percentage=" + percentage + "%");

                com.google.gson.Gson gson = new com.google.gson.Gson();
                com.google.gson.JsonObject usageUpdate = new com.google.gson.JsonObject();
                usageUpdate.addProperty("percentage", percentage);
                usageUpdate.addProperty("totalTokens", usedTokens);
                usageUpdate.addProperty("limit", maxTokens);
                usageUpdate.addProperty("usedTokens", usedTokens);
                usageUpdate.addProperty("maxTokens", maxTokens);
                String usageJson = gson.toJson(usageUpdate);

                javax.swing.SwingUtilities.invokeLater(() -> {
                    System.out.println("[Backend] Calling window.onUsageUpdate with payload length=" + usageJson.length());
                    String js = "if (window.onUsageUpdate) { window.onUsageUpdate('" + escapeJs(usageJson) + "'); }";
                    browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to push usage update: " + e.getMessage());
            }
        }

        /**
         * 创建新会话
         */
        private void createNewSession() {
            System.out.println("Creating new session...");

            // 更新状态
            callJavaScript("updateStatus", escapeJs("正在创建新会话..."));

            // 创建新的 Session 实例（不设置 sessionId，让 SDK 自动生成）
            session = new ClaudeSession(sdkBridge);
            setupSessionCallbacks();

            // 智能确定工作目录
            String workingDirectory = determineWorkingDirectory();
            session.setSessionInfo(null, workingDirectory);  // sessionId 为 null 表示新会话
            System.out.println("New session created with cwd: " + workingDirectory);

            // 在UI中显示当前工作目录
            callJavaScript("updateStatus", escapeJs("工作目录: " + workingDirectory));

            // 更新 UI
            SwingUtilities.invokeLater(() -> {
                callJavaScript("updateStatus", escapeJs("新会话已创建，可以开始提问"));
                // 新建会话后，重置使用量为 0%
                int maxTokens = MODEL_CONTEXT_LIMITS.getOrDefault(currentModel, 272_000);
                com.google.gson.Gson gson = new com.google.gson.Gson();
                com.google.gson.JsonObject usageUpdate = new com.google.gson.JsonObject();
                usageUpdate.addProperty("percentage", 0);
                usageUpdate.addProperty("totalTokens", 0);
                usageUpdate.addProperty("limit", maxTokens);
                usageUpdate.addProperty("usedTokens", 0);
                usageUpdate.addProperty("maxTokens", maxTokens);
                String usageJson = gson.toJson(usageUpdate);
                String js = "if (window.onUsageUpdate) { window.onUsageUpdate('" + escapeJs(usageJson) + "'); }";
                browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
            });
        }

        /**
         * 发送消息到 Claude（使用 Session）
         */
        private void sendMessageToClaude(String prompt) {
            // 将整个处理过程移到后台线程，避免 EDT 死锁
            CompletableFuture.runAsync(() -> {
                // 每次发送消息前，动态更新工作目录（确保使用最新的当前文件目录）
                String currentWorkingDir = determineWorkingDirectory();
                String previousCwd = session.getCwd();

                // 如果工作目录变化了，更新它
                if (!currentWorkingDir.equals(previousCwd)) {
                    session.setCwd(currentWorkingDir);
                    System.out.println("[ClaudeChatWindow] Updated working directory: " + currentWorkingDir);
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("updateStatus", escapeJs("工作目录: " + currentWorkingDir));
                    });
                }

                // 使用 default 模式，会触发权限请求
                session.setPermissionMode("default");

                // 直接发送原始消息，工作目录已经在底层正确处理
                // 不再需要关键词匹配和提示，因为ProcessBuilder和channel-manager.js已经智能处理了工作目录

                // 使用 Session 发送消息
                session.send(prompt).exceptionally(ex -> {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("发送失败: " + ex.getMessage()));
                    });
                    return null;
                });
            });
        }

        /**
         * 发送带附件的消息到 Claude（使用 Session）
         */
        private void sendMessageToClaudeWithAttachments(String prompt, java.util.List<com.github.claudecodegui.ClaudeSession.Attachment> attachments) {
            CompletableFuture.runAsync(() -> {
                String currentWorkingDir = determineWorkingDirectory();
                String previousCwd = session.getCwd();
                if (!currentWorkingDir.equals(previousCwd)) {
                    session.setCwd(currentWorkingDir);
                    System.out.println("[ClaudeChatWindow] Updated working directory: " + currentWorkingDir);
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("updateStatus", escapeJs("工作目录: " + currentWorkingDir));
                    });
                }

                session.setPermissionMode("default");

                session.send(prompt, attachments).exceptionally(ex -> {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("发送失败: " + ex.getMessage()));
                    });
                    return null;
                });
            });
        }

        private void interruptDueToPermissionDenial() {
            session.interrupt().thenRun(() -> SwingUtilities.invokeLater(() -> {
                callJavaScript("updateStatus", escapeJs("权限被拒，已中断会话"));
            }));
        }

        /**
         * 打开浏览器
         */
        private void openBrowser(String url) {
            SwingUtilities.invokeLater(() -> {
                try {
                    BrowserUtil.browse(url);
                } catch (Exception e) {
                    System.err.println("无法打开浏览器: " + e.getMessage());
                }
            });
        }

        /**
         * 在编辑器中打开文件
         */
        private void openFileInEditor(String filePath) {
            System.out.println("请求打开文件: " + filePath);

            SwingUtilities.invokeLater(() -> {
                try {
                    // 检查文件是否存在
                    File file = new File(filePath);
                    
                    // 如果文件不存在且是相对路径，尝试相对于项目根目录解析
                    if (!file.exists() && !file.isAbsolute() && project.getBasePath() != null) {
                        File projectFile = new File(project.getBasePath(), filePath);
                        System.out.println("尝试相对于项目根目录解析: " + projectFile.getAbsolutePath());
                        if (projectFile.exists()) {
                            file = projectFile;
                        }
                    }
                    
                    if (!file.exists()) {
                        System.err.println("文件不存在: " + filePath);
                        callJavaScript("addErrorMessage", escapeJs("无法打开文件: 文件不存在 (" + filePath + ")"));
                        return;
                    }

                    // 使用 LocalFileSystem 获取 VirtualFile
                    VirtualFile virtualFile = LocalFileSystem.getInstance().findFileByIoFile(file);
                    if (virtualFile == null) {
                        System.err.println("无法获取 VirtualFile: " + filePath);
                        return;
                    }

                    // 在编辑器中打开文件
                    FileEditorManager.getInstance(project).openFile(virtualFile, true);
                    System.out.println("成功打开文件: " + filePath);

                } catch (Exception e) {
                    System.err.println("打开文件失败: " + e.getMessage());
                    e.printStackTrace();
                }
            });
        }

        /**
         * 调用 JavaScript 函数
         */
        private void callJavaScript(String functionName, String... args) {
            if (browser == null) return;

            StringBuilder js = new StringBuilder();
            js.append("if (typeof ").append(functionName).append(" === 'function') { ");
            js.append(functionName).append("(");

            for (int i = 0; i < args.length; i++) {
                if (i > 0) js.append(", ");
                js.append("'").append(args[i]).append("'");
            }

            js.append("); }");

            browser.getCefBrowser().executeJavaScript(js.toString(), browser.getCefBrowser().getURL(), 0);
        }

        /**
         * 转义 JavaScript 字符串
         */
        private String escapeJs(String str) {
            return str
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
        }

        /**
         * 生成聊天界面 HTML
         */
        private String generateChatHTML(JBCefJSQuery jsQuery) {
            // 尝试从资源文件加载 HTML
            try {
                java.io.InputStream is = getClass().getResourceAsStream("/html/claude-chat.html");
                if (is != null) {
                    String html = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                    is.close();
                    
                    // 仅在旧版 HTML 中存在注入标记时才进行替换
                    if (html.contains("<!-- LOCAL_LIBRARY_INJECTION_POINT -->")) {
                        html = injectLocalLibraries(html);
                    } else {
                        System.out.println("✓ 检测到打包好的现代前端资源，无需额外注入库文件");
                    }
                    
                    return html;
                }
            } catch (Exception e) {
                System.err.println("无法加载 claude-chat.html: " + e.getMessage());
            }

            // 备用：返回简单的 HTML
            return """
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }

                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            background: #1e1e1e;
                            color: #cccccc;
                            height: 100vh;
                            display: flex;
                            flex-direction: column;
                        }

                        .header {
                            padding: 16px;
                            background: #252526;
                            border-bottom: 1px solid #3e3e42;
                        }

                        .header h1 {
                            font-size: 16px;
                            font-weight: 600;
                            margin-bottom: 4px;
                        }

                        .header .status {
                            font-size: 12px;
                            color: #858585;
                        }

                        .messages {
                            flex: 1;
                            overflow-y: auto;
                            padding: 16px;
                        }

                        .message {
                            margin-bottom: 16px;
                            padding: 12px;
                            border-radius: 8px;
                            max-width: 80%;
                            word-wrap: break-word;
                        }

                        .message.user {
                            background: #2d5a8c;
                            margin-left: auto;
                            text-align: right;
                        }

                        .message.assistant {
                            background: #2d2d2d;
                        }

                        .message.error {
                            background: #5a1d1d;
                            color: #f48771;
                        }

                        .message .role {
                            font-size: 11px;
                            opacity: 0.7;
                            margin-bottom: 4px;
                            text-transform: uppercase;
                        }

                        .loading {
                            display: none;
                            padding: 12px;
                            text-align: center;
                            color: #858585;
                        }

                        .loading.show {
                            display: block;
                        }

                        .loading::after {
                            content: '...';
                            animation: dots 1.5s steps(4, end) infinite;
                        }

                        @keyframes dots {
                            0%, 20% { content: '.'; }
                            40% { content: '..'; }
                            60%, 100% { content: '...'; }
                        }

                        .input-area {
                            padding: 16px;
                            background: #252526;
                            border-top: 1px solid #3e3e42;
                        }

                        .input-container {
                            display: flex;
                            gap: 8px;
                        }

                        #messageInput {
                            flex: 1;
                            padding: 10px 12px;
                            background: #3c3c3c;
                            border: 1px solid #555;
                            border-radius: 4px;
                            color: #cccccc;
                            font-size: 14px;
                            resize: none;
                            font-family: inherit;
                        }

                        #messageInput:focus {
                            outline: none;
                            border-color: #4a90e2;
                        }

                        #sendButton {
                            padding: 10px 20px;
                            background: #4a90e2;
                            border: none;
                            border-radius: 4px;
                            color: white;
                            font-size: 14px;
                            cursor: pointer;
                            font-weight: 500;
                        }

                        #sendButton:hover {
                            background: #5a9ee8;
                        }

                        #sendButton:active {
                            background: #3a80d2;
                        }

                        #sendButton:disabled {
                            background: #555;
                            cursor: not-allowed;
                        }

                        ::-webkit-scrollbar {
                            width: 8px;
                        }

                        ::-webkit-scrollbar-track {
                            background: #1e1e1e;
                        }

                        ::-webkit-scrollbar-thumb {
                            background: #424242;
                            border-radius: 4px;
                        }

                        ::-webkit-scrollbar-thumb:hover {
                            background: #4f4f4f;
                        }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <h1>Claude Code GUI</h1>
                            <div style="display: flex; gap: 8px;">
                                <button onclick="interruptSession()" style="padding: 4px 12px; background: #5a5a5a; border: none; border-radius: 4px; color: white; cursor: pointer; font-size: 12px;">⏸ 中断</button>
                                <button onclick="restartSession()" style="padding: 4px 12px; background: #5a5a5a; border: none; border-radius: 4px; color: white; cursor: pointer; font-size: 12px;">🔄 重启</button>
                            </div>
                        </div>
                        <div class="status" id="status">就绪</div>
                    </div>

                    <div class="messages" id="messages">
                    </div>

                    <div class="loading" id="loading">Claude 正在思考</div>

                    <div class="input-area">
                        <div class="input-container">
                            <textarea
                                id="messageInput"
                                placeholder="输入消息... (Shift+Enter 换行, Enter 发送)"
                                rows="1"
                            ></textarea>
                            <button id="sendButton" onclick="sendMessage()">发送</button>
                        </div>
                    </div>

                    <script>
                        const messagesDiv = document.getElementById('messages');
                        const messageInput = document.getElementById('messageInput');
                        const sendButton = document.getElementById('sendButton');
                        const loadingDiv = document.getElementById('loading');
                        const statusDiv = document.getElementById('status');

                        // 更新消息列表
                        function updateMessages(messagesJson) {
                            const messages = JSON.parse(messagesJson);
                            messagesDiv.innerHTML = '';

                            messages.forEach(msg => {
                                if (msg.type === 'user') {
                                    addUserMessage(msg.content);
                                } else if (msg.type === 'assistant') {
                                    addAssistantMessage(msg.content);
                                } else if (msg.type === 'error') {
                                    addErrorMessage(msg.content);
                                }
                            });
                            scrollToBottom();
                        }

                        // 发送消息
                        function sendMessage() {
                            const message = messageInput.value.trim();
                            if (!message) return;

                            // 通过桥接发送到 Java
                            window.sendToJava('send_message:' + message);

                            // 清空输入框
                            messageInput.value = '';
                            messageInput.style.height = 'auto';
                        }

                        // 添加用户消息
                        function addUserMessage(text) {
                            const msgDiv = document.createElement('div');
                            msgDiv.className = 'message user';
                            msgDiv.innerHTML = '<div class="role">You</div><div>' + text + '</div>';
                            messagesDiv.appendChild(msgDiv);
                            scrollToBottom();
                        }

                        // 添加助手消息
                        function addAssistantMessage(text) {
                            const msgDiv = document.createElement('div');
                            msgDiv.className = 'message assistant';
                            msgDiv.innerHTML = '<div class="role">Assistant</div><div>' + text + '</div>';
                            messagesDiv.appendChild(msgDiv);
                            scrollToBottom();
                        }

                        // 添加错误消息
                        function addErrorMessage(text) {
                            const msgDiv = document.createElement('div');
                            msgDiv.className = 'message error';
                            msgDiv.innerHTML = '<div class="role">Error</div><div>' + text + '</div>';
                            messagesDiv.appendChild(msgDiv);
                            scrollToBottom();
                        }

                        // 显示/隐藏加载状态
                        function showLoading(show) {
                            if (show === 'true') {
                                loadingDiv.classList.add('show');
                                sendButton.disabled = true;
                            } else {
                                loadingDiv.classList.remove('show');
                                sendButton.disabled = false;
                            }
                        }

                        // 更新状态
                        function updateStatus(text) {
                            statusDiv.textContent = text;
                        }

                        // 滚动到底部
                        function scrollToBottom() {
                            messagesDiv.scrollTop = messagesDiv.scrollHeight;
                        }

                        // 清空所有消息
                        function clearMessages() {
                            messagesDiv.innerHTML = '';
                        }

                        // 中断会话
                        function interruptSession() {
                            window.sendToJava('interrupt_session:');
                            updateStatus('已发送中断请求');
                        }

                        // 重启会话
                        function restartSession() {
                            if (confirm('确定要重启会话吗？这将清空当前对话历史。')) {
                                window.sendToJava('restart_session:');
                                clearMessages();
                                updateStatus('正在重启会话...');
                            }
                        }

                        // 处理键盘事件
                        messageInput.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                sendMessage();
                            }
                        });

                        // 自动调整输入框高度
                        messageInput.addEventListener('input', function() {
                            this.style.height = 'auto';
                            this.style.height = (this.scrollHeight) + 'px';
                        });
                    </script>
                </body>
                </html>
                """;
        }

        /**
         * 显示权限请求对话框
         */
        private void showPermissionDialog(PermissionRequest request) {
            System.out.println("显示权限请求对话框: " + request.getToolName());

            PermissionDialog dialog = new PermissionDialog(project, request);
            dialog.setDecisionCallback(decision -> {
                // 处理权限决策
                session.handlePermissionDecision(
                    decision.channelId,
                    decision.allow,
                    decision.remember,
                    decision.rejectMessage
                );
                if (!decision.allow) {
                    interruptDueToPermissionDenial();
                }
            });
            dialog.show();
        }

        /**
         * 处理来自JavaScript的权限决策消息
         */
        private void handlePermissionDecision(String jsonContent) {
            try {
                Gson gson = new Gson();
                JsonObject decision = gson.fromJson(jsonContent, JsonObject.class);

                String channelId = decision.get("channelId").getAsString();
                boolean allow = decision.get("allow").getAsBoolean();
                boolean remember = decision.get("remember").getAsBoolean();
                String rejectMessage = decision.has("rejectMessage") ?
                    decision.get("rejectMessage").getAsString() : "";

                session.handlePermissionDecision(channelId, allow, remember, rejectMessage);
                if (!allow) {
                    interruptDueToPermissionDenial();
                }
            } catch (Exception e) {
                System.err.println("处理权限决策失败: " + e.getMessage());
                e.printStackTrace();
            }
        }

        /**
         * 将本地库文件内容注入到 HTML 中
         */
        private String injectLocalLibraries(String html) {
            try {
                // 读取本地库文件
                String reactJs = loadResourceAsString("/libs/react.production.min.js");
                String reactDomJs = loadResourceAsString("/libs/react-dom.production.min.js");
                String babelJs = loadResourceAsString("/libs/babel.min.js");
                String markedJs = loadResourceAsString("/libs/marked.min.js");
                String codiconCss = loadResourceAsString("/libs/codicon.css");
                
                // 将字体文件转换为 base64 并嵌入到 CSS 中
                String fontBase64 = loadResourceAsBase64("/libs/codicon.ttf");
                codiconCss = codiconCss.replaceAll(
                    "url\\(\"\\./codicon\\.ttf\\?[^\"]*\"\\)",
                    "url(\"data:font/truetype;base64," + fontBase64 + "\")"
                );
                
                // 构建要注入的库内容
                StringBuilder injectedLibs = new StringBuilder();
                injectedLibs.append("\n    <!-- React 和相关库 (本地版本) -->\n");
                injectedLibs.append("    <script>/* React 18 */\n").append(reactJs).append("\n    </script>\n");
                injectedLibs.append("    <script>/* ReactDOM 18 */\n").append(reactDomJs).append("\n    </script>\n");
                injectedLibs.append("    <script>/* Babel Standalone */\n").append(babelJs).append("\n    </script>\n");
                injectedLibs.append("    <script>/* Marked */\n").append(markedJs).append("\n    </script>\n");
                injectedLibs.append("    <style>/* VS Code Codicons (含内嵌字体) */\n").append(codiconCss).append("\n    </style>");
                
                // 在标记位置注入库文件
                html = html.replace("<!-- LOCAL_LIBRARY_INJECTION_POINT -->", injectedLibs.toString());
                
                System.out.println("✓ 成功注入本地库文件 (React + ReactDOM + Babel + Codicons)");
            } catch (Exception e) {
                System.err.println("✗ 注入本地库文件失败: " + e.getMessage());
                e.printStackTrace();
                // 如果注入失败，HTML 保持原样（但没有库文件，可能无法正常工作）
            }
            
            return html;
        }
        
        /**
         * 从资源文件中读取内容为字符串
         */
        private String loadResourceAsString(String resourcePath) throws Exception {
            java.io.InputStream is = getClass().getResourceAsStream(resourcePath);
            if (is == null) {
                throw new Exception("无法找到资源: " + resourcePath);
            }
            String content = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            is.close();
            return content;
        }
        
        /**
         * 从资源文件中读取内容并转换为 base64
         */
        private String loadResourceAsBase64(String resourcePath) throws Exception {
            java.io.InputStream is = getClass().getResourceAsStream(resourcePath);
            if (is == null) {
                throw new Exception("无法找到资源: " + resourcePath);
            }
            byte[] bytes = is.readAllBytes();
            is.close();
            return java.util.Base64.getEncoder().encodeToString(bytes);
        }

        /**
         * 获取所有供应商
         */
        private void handleGetProviders() {
            try {
                List<JsonObject> providers = settingsService.getClaudeProviders();
                Gson gson = new Gson();
                String providersJson = gson.toJson(providers);

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateProviders", escapeJs(providersJson));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to get providers: " + e.getMessage());
                e.printStackTrace();
            }
        }

        /**
         * 添加供应商
         */
        private void handleAddProvider(String content) {
            try {
                Gson gson = new Gson();
                JsonObject provider = gson.fromJson(content, JsonObject.class);
                settingsService.addClaudeProvider(provider);

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateStatus", escapeJs("供应商添加成功"));
                    handleGetProviders(); // 刷新列表
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to add provider: " + e.getMessage());
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("添加供应商失败: " + e.getMessage()));
                });
            }
        }

        /**
         * 更新供应商
         */
        private void handleUpdateProvider(String content) {
            try {
                Gson gson = new Gson();
                JsonObject data = gson.fromJson(content, JsonObject.class);
                String id = data.get("id").getAsString();
                JsonObject updates = data.getAsJsonObject("updates");

                settingsService.updateClaudeProvider(id, updates);

                boolean syncedActiveProvider = false;
                JsonObject activeProvider = settingsService.getActiveClaudeProvider();
                if (activeProvider != null &&
                    activeProvider.has("id") &&
                    id.equals(activeProvider.get("id").getAsString())) {
                    settingsService.applyProviderToClaudeSettings(activeProvider);
                    syncedActiveProvider = true;
                }

                final boolean finalSynced = syncedActiveProvider;
                SwingUtilities.invokeLater(() -> {
                    if (finalSynced) {
                        callJavaScript("window.updateStatus", escapeJs("供应商更新成功，已同步到 ~/.claude/settings.json"));
                    } else {
                        callJavaScript("window.updateStatus", escapeJs("供应商更新成功"));
                    }
                    handleGetProviders(); // 刷新列表
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to update provider: " + e.getMessage());
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("更新供应商失败: " + e.getMessage()));
                });
            }
        }

        /**
         * 删除供应商
         */
        private void handleDeleteProvider(String content) {
            System.out.println("[Backend] ========== handleDeleteProvider START ==========");
            System.out.println("[Backend] Received content: " + content);

            try {
                Gson gson = new Gson();
                JsonObject data = gson.fromJson(content, JsonObject.class);
                System.out.println("[Backend] Parsed JSON data: " + data);

                if (!data.has("id")) {
                    System.err.println("[Backend] ERROR: Missing 'id' field in request");
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("window.showError", escapeJs("删除失败: 请求中缺少供应商 ID"));
                    });
                    return;
                }

                String id = data.get("id").getAsString();
                System.out.println("[Backend] Deleting provider with ID: " + id);

                // 使用新的 DeleteResult 返回值，获取详细错误信息
                DeleteResult result = settingsService.deleteClaudeProvider(id);
                System.out.println("[Backend] Delete result - success: " + result.isSuccess());

                if (result.isSuccess()) {
                    System.out.println("[Backend] Delete successful, refreshing provider list");
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("window.updateStatus", escapeJs("供应商删除成功"));
                        handleGetProviders(); // 刷新列表
                    });
                } else {
                    // 删除失败，显示详细错误信息
                    String errorMsg = result.getUserFriendlyMessage();
                    System.err.println("[Backend] Delete provider failed: " + errorMsg);
                    System.err.println("[Backend] Error type: " + result.getErrorType());
                    System.err.println("[Backend] Error details: " + result.getErrorMessage());
                    SwingUtilities.invokeLater(() -> {
                        System.out.println("[Backend] Calling window.showError with: " + errorMsg);
                        callJavaScript("window.showError", escapeJs(errorMsg));
                    });
                }
            } catch (Exception e) {
                System.err.println("[Backend] Exception in handleDeleteProvider: " + e.getMessage());
                e.printStackTrace();
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("删除供应商失败: " + e.getMessage()));
                });
            }

            System.out.println("[Backend] ========== handleDeleteProvider END ==========");
        }

        /**
         * 切换供应商
         */
        private void handleSwitchProvider(String content) {
            try {
                Gson gson = new Gson();
                JsonObject data = gson.fromJson(content, JsonObject.class);
                String id = data.get("id").getAsString();

                settingsService.switchClaudeProvider(id);
                settingsService.applyActiveProviderToClaudeSettings();

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("alert", escapeJs("✅ 供应商切换成功！\n\n已自动同步到 ~/.claude/settings.json，下一次提问将使用新的配置。"));
                    callJavaScript("window.updateStatus", escapeJs("供应商切换成功，已同步到 ~/.claude/settings.json"));
                    handleGetProviders(); // 刷新列表
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to switch provider: " + e.getMessage());
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("切换供应商失败: " + e.getMessage()));
                });
            }
        }

        /**
         * 获取当前激活的供应商
         */
        private void handleGetActiveProvider() {
            try {
                JsonObject provider = settingsService.getActiveClaudeProvider();
                Gson gson = new Gson();
                String providerJson = gson.toJson(provider);

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateActiveProvider", escapeJs(providerJson));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to get active provider: " + e.getMessage());
                e.printStackTrace();
            }
        }

        /**
         * 获取使用统计数据
         */
        private void handleGetUsageStatistics(String content) {
            CompletableFuture.runAsync(() -> {
                try {
                    String projectPath = "all";
                    // 解析请求内容
                    // 简单处理：如果内容是 "current"，则使用当前项目路径
                    // 否则如果是路径，则使用该路径
                    // 默认为 "all"

                    if (content != null && !content.isEmpty() && !content.equals("{}")) {
                        // 尝试解析 JSON
                         try {
                            Gson gson = new Gson();
                            JsonObject json = gson.fromJson(content, JsonObject.class);
                            if (json.has("scope")) {
                                String scope = json.get("scope").getAsString();
                                if ("current".equals(scope)) {
                                    projectPath = project.getBasePath();
                                } else {
                                    projectPath = "all";
                                }
                            }
                        } catch (Exception e) {
                            // 不是 JSON，按字符串处理
                            if ("current".equals(content)) {
                                projectPath = project.getBasePath();
                            } else {
                                projectPath = content;
                            }
                        }
                    }

                    System.out.println("[Backend] Getting usage statistics for path: " + projectPath);

                    ClaudeHistoryReader reader = new ClaudeHistoryReader();
                    ClaudeHistoryReader.ProjectStatistics stats = reader.getProjectStatistics(projectPath);

                    Gson gson = new Gson();
                    String json = gson.toJson(stats);

                    // 计算使用百分比
                    // 基于 token 使用量计算，假设月度限额为 500 万 tokens
                    int totalTokens = 0;
                    if (stats != null && stats.totalUsage != null) {
                        totalTokens = stats.totalUsage.inputTokens + stats.totalUsage.outputTokens;
                    }
                    final int MONTHLY_TOKEN_LIMIT = 5_000_000; // 500 万 tokens
                    int percentage = Math.min(100, (int) ((totalTokens * 100.0) / MONTHLY_TOKEN_LIMIT));

                    // 创建用量更新数据
                    JsonObject usageUpdate = new JsonObject();
                    usageUpdate.addProperty("percentage", percentage);
                    usageUpdate.addProperty("totalTokens", totalTokens);
                    usageUpdate.addProperty("limit", MONTHLY_TOKEN_LIMIT);
                    if (stats != null) {
                        usageUpdate.addProperty("estimatedCost", stats.estimatedCost);
                    }
                    String usageJson = gson.toJson(usageUpdate);

                    // 为 lambda 捕获创建最终变量快照
                    final int tokensFinal = totalTokens;
                    final int limitFinal = MONTHLY_TOKEN_LIMIT;
                    final int percentageFinal = percentage;
                    final String statsJsonFinal = json;

                    SwingUtilities.invokeLater(() -> {
                        // 发送完整统计数据（用于统计视图）
                        System.out.println("[Backend] updateUsageStatistics: tokens=" + tokensFinal + ", limit=" + limitFinal + ", percentage=" + percentageFinal + "% (not pushing onUsageUpdate)");
                        callJavaScript("window.updateUsageStatistics", escapeJs(statsJsonFinal));
                        // 不在这里调用 window.onUsageUpdate，避免覆盖聊天输入框的实时进度
                    });
                } catch (Exception e) {
                    System.err.println("[Backend] Failed to get usage statistics: " + e.getMessage());
                    e.printStackTrace();
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("window.showError", escapeJs("获取统计数据失败: " + e.getMessage()));
                    });
                }
            });
        }

        /**
         * 处理文件列表请求
         */
        private void handleListFiles(String content) {
            CompletableFuture.runAsync(() -> {
                try {
                    String query = "";
                    if (content != null && !content.isEmpty()) {
                        try {
                            Gson gson = new Gson();
                            JsonObject json = gson.fromJson(content, JsonObject.class);
                            if (json.has("query")) {
                                query = json.get("query").getAsString();
                            }
                        } catch (Exception e) {
                            // content 可能是纯字符串
                            query = content;
                        }
                    }

                    // 优先使用当前会话的工作目录，其次项目根目录，最后用户主目录
                    String basePath = session != null && session.getCwd() != null && !session.getCwd().isEmpty()
                        ? session.getCwd()
                        : (project.getBasePath() != null ? project.getBasePath() : System.getProperty("user.home"));

                    java.util.List<JsonObject> files = new java.util.ArrayList<>();
                    File baseDir = new File(basePath);

                    // 递归收集文件（限制深度和数量）
                    collectFiles(baseDir, basePath, files, query.toLowerCase(), 0, 3, 200);

                    // 如果没有结果且查询为空，提供顶层后备列表，避免前端空白
                    if (files.isEmpty() && (query == null || query.isEmpty())) {
                        File[] children = baseDir.listFiles();
                        if (children != null) {
                            int added = 0;
                            for (File child : children) {
                                if (added >= 20) break;
                                String name = child.getName();
                                if (name.startsWith(".") || name.equals("node_modules") || name.equals("dist") || name.equals("out")) {
                                    continue;
                                }
                                JsonObject fileObj = new JsonObject();
                                fileObj.addProperty("name", name);
                                String rel = child.getAbsolutePath().substring(basePath.length());
                                if (rel.startsWith(File.separator)) rel = rel.substring(1);
                                rel = rel.replace("\\", "/");
                                fileObj.addProperty("path", rel);
                                fileObj.addProperty("type", child.isDirectory() ? "directory" : "file");
                                if (child.isFile()) {
                                    int dotIndex = name.lastIndexOf('.');
                                    if (dotIndex > 0) {
                                        fileObj.addProperty("extension", name.substring(dotIndex + 1));
                                    }
                                }
                                files.add(fileObj);
                                added++;
                            }
                        }
                    }

                    // 目录优先排序，然后按名称排序
                    files.sort((a, b) -> {
                        boolean aDir = "directory".equals(a.get("type").getAsString());
                        boolean bDir = "directory".equals(b.get("type").getAsString());
                        if (aDir != bDir) return aDir ? -1 : 1;
                        return a.get("name").getAsString().compareToIgnoreCase(b.get("name").getAsString());
                    });

                    Gson gson = new Gson();
                    JsonObject result = new JsonObject();
                    result.add("files", gson.toJsonTree(files));
                    String resultJson = gson.toJson(result);

                    SwingUtilities.invokeLater(() -> {
                        // 使用统一的 JS 调用封装，避免某些环境下注入差异
                        callJavaScript("window.onFileListResult", escapeJs(resultJson));
                    });
                } catch (Exception e) {
                    System.err.println("[Backend] Failed to list files: " + e.getMessage());
                    e.printStackTrace();
                }
            });
        }

        /**
         * 递归收集文件
         */
        private void collectFiles(File dir, String basePath, java.util.List<JsonObject> files,
                                  String query, int depth, int maxDepth, int maxFiles) {
            if (depth > maxDepth || files.size() >= maxFiles) return;
            if (!dir.isDirectory()) return;

            File[] children = dir.listFiles();
            if (children == null) return;

            for (File child : children) {
                if (files.size() >= maxFiles) break;

                String name = child.getName();
                // 跳过隐藏文件和常见的忽略目录
                if (name.startsWith(".") ||
                    name.equals("node_modules") ||
                    name.equals("target") ||
                    name.equals("build") ||
                    name.equals("dist") ||
                    name.equals("out") ||
                    name.equals("__pycache__")) {
                    continue;
                }

                String relativePath = child.getAbsolutePath().substring(basePath.length());
                if (relativePath.startsWith(File.separator)) {
                    relativePath = relativePath.substring(1);
                }
                // 统一使用正斜杠
                relativePath = relativePath.replace("\\", "/");

                // 检查是否匹配查询
                if (!query.isEmpty() &&
                    !name.toLowerCase().contains(query) &&
                    !relativePath.toLowerCase().contains(query)) {
                    // 如果是目录，仍然递归搜索
                    if (child.isDirectory()) {
                        collectFiles(child, basePath, files, query, depth + 1, maxDepth, maxFiles);
                    }
                    continue;
                }

                JsonObject fileObj = new JsonObject();
                fileObj.addProperty("name", name);
                fileObj.addProperty("path", relativePath);
                fileObj.addProperty("type", child.isDirectory() ? "directory" : "file");

                if (child.isFile()) {
                    int dotIndex = name.lastIndexOf('.');
                    if (dotIndex > 0) {
                        fileObj.addProperty("extension", name.substring(dotIndex + 1));
                    }
                }

                files.add(fileObj);

                // 递归处理目录
                if (child.isDirectory()) {
                    collectFiles(child, basePath, files, query, depth + 1, maxDepth, maxFiles);
                }
            }
        }

        /**
         * 处理获取命令列表请求
         */
        private void handleGetCommands(String content) {
            CompletableFuture.runAsync(() -> {
                try {
                    String query = "";
                    if (content != null && !content.isEmpty()) {
                        try {
                            Gson gson = new Gson();
                            JsonObject json = gson.fromJson(content, JsonObject.class);
                            if (json.has("query")) {
                                query = json.get("query").getAsString();
                            }
                        } catch (Exception e) {
                            query = content;
                        }
                    }

                    // 默认命令列表
                    java.util.List<JsonObject> commands = new java.util.ArrayList<>();

                    addCommand(commands, "/help", "显示帮助信息", query);
                    addCommand(commands, "/clear", "清空对话历史", query);
                    addCommand(commands, "/new", "创建新会话", query);
                    addCommand(commands, "/history", "查看历史记录", query);
                    addCommand(commands, "/model", "切换模型", query);
                    addCommand(commands, "/settings", "打开设置", query);
                    addCommand(commands, "/compact", "压缩对话上下文", query);

                    Gson gson = new Gson();
                    JsonObject result = new JsonObject();
                    result.add("commands", gson.toJsonTree(commands));
                    String resultJson = gson.toJson(result);

                    SwingUtilities.invokeLater(() -> {
                        String js = "if (window.onCommandListResult) { window.onCommandListResult('" + escapeJs(resultJson) + "'); }";
                        browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
                    });
                } catch (Exception e) {
                    System.err.println("[Backend] Failed to get commands: " + e.getMessage());
                    e.printStackTrace();
                }
            });
        }

        /**
         * 添加命令到列表
         */
        private void addCommand(java.util.List<JsonObject> commands, String label, String description, String query) {
            if (query.isEmpty() ||
                label.toLowerCase().contains(query.toLowerCase()) ||
                description.toLowerCase().contains(query.toLowerCase())) {
                JsonObject cmd = new JsonObject();
                cmd.addProperty("label", label);
                cmd.addProperty("description", description);
                commands.add(cmd);
            }
        }

        /**
         * 处理设置模式请求
         */
        private void handleSetMode(String content) {
            try {
                String mode = content;
                if (content != null && !content.isEmpty()) {
                    try {
                        Gson gson = new Gson();
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("mode")) {
                            mode = json.get("mode").getAsString();
                        }
                    } catch (Exception e) {
                        // content 本身就是 mode
                    }
                }

                System.out.println("[Backend] Setting permission mode to: " + mode);
                session.setPermissionMode(mode);

                final String finalMode = mode;
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateStatus", escapeJs("权限模式已设置为: " + finalMode));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to set mode: " + e.getMessage());
                e.printStackTrace();
            }
        }

        /**
         * 处理设置模型请求
         */
        private void handleSetModel(String content) {
            try {
                String model = content;
                if (content != null && !content.isEmpty()) {
                    try {
                        Gson gson = new Gson();
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("model")) {
                            model = json.get("model").getAsString();
                        }
                    } catch (Exception e) {
                        // content 本身就是 model
                    }
                }

                System.out.println("[Backend] Setting model to: " + model);
                this.currentModel = model;

                final String finalModel = model;
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateStatus", escapeJs("模型已设置为: " + finalModel));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to set model: " + e.getMessage());
                e.printStackTrace();
            }
        }

        public JPanel getContent() {
            return mainPanel;
        }
    }
}
