package com.github.claudecodegui;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefJSQuery;
import com.intellij.ide.util.PropertiesComponent;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory;
import com.intellij.openapi.ui.Messages;
import com.github.claudecodegui.permission.PermissionDialog;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import javax.swing.*;
import java.awt.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.io.File;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

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
     * 静态方法，用于从外部添加选中的代码信息
     */
    public static void addSelectionFromExternal(String selectionInfo) {
        ClaudeChatWindow.addSelectionFromExternalInternal(selectionInfo);
    }

    /**
     * 聊天窗口内部类
     */
    private static class ClaudeChatWindow {
        // 静态引用，用于从外部访问
        private static ClaudeChatWindow instance;

        private final JPanel mainPanel;
        private final ClaudeSDKBridge claudeSDKBridge;
        private final CodexSDKBridge codexSDKBridge;
        private final Project project;
        private JBCefBrowser browser;
        private ClaudeSession session; // 添加 Session 管理
        private ToolInterceptor toolInterceptor; // 工具拦截器
        private CodemossSettingsService settingsService; // 配置服务
        private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";
        private String currentModel = "claude-sonnet-4-5";
        private String currentProvider = "claude"; // 当前提供商
        private static final java.util.Map<String, Integer> MODEL_CONTEXT_LIMITS = new java.util.HashMap<>();
        static {
            MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-5", 200_000);
            MODEL_CONTEXT_LIMITS.put("claude-opus-4-5-20251101", 200_000);
        }

        public ClaudeChatWindow(Project project) {
            this.project = project;
            this.claudeSDKBridge = new ClaudeSDKBridge();
            this.codexSDKBridge = new CodexSDKBridge();
            this.session = new ClaudeSession(claudeSDKBridge, codexSDKBridge); // 创建新会话
            this.toolInterceptor = new ToolInterceptor(project); // 创建工具拦截器
            this.settingsService = new CodemossSettingsService(); // 创建配置服务

            // 设置静态引用，用于从外部访问
            instance = this;

            try {
                this.settingsService.applyActiveProviderToClaudeSettings();
            } catch (Exception e) {
                System.err.println("[ClaudeChatWindow] Failed to sync active provider on startup: " + e.getMessage());
            }
            this.mainPanel = new JPanel(new BorderLayout());

            // 在环境检查前，尝试加载用户手动配置的 Node.js 路径
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);
                if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                    String path = savedNodePath.trim();
                    System.out.println("[ClaudeChatWindow] Using manually configured Node.js path: " + path);
                    claudeSDKBridge.setNodeExecutable(path);
                }
            } catch (Exception e) {
                System.err.println("[ClaudeChatWindow] Failed to load manual Node.js path: " + e.getMessage());
            }

            // 启动权限服务
            PermissionService permissionService = PermissionService.getInstance(project);
            permissionService.start();
            // 注意：不再设置 decisionListener，因为我们在 handlePermissionDecision 中已经处理了中断逻辑
            // 设置 decisionListener 会导致重复中断

            // 设置前端弹窗显示器
            permissionService.setDialogShower(new PermissionService.PermissionDialogShower() {
                @Override
                public CompletableFuture<Integer> showPermissionDialog(String toolName, JsonObject inputs) {
                    return showFrontendPermissionDialog(toolName, inputs);
                }
            });

            System.out.println("[ClaudeChatWindow] Started permission service with frontend dialog");

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
            if (!claudeSDKBridge.checkEnvironment()) {
                showErrorPanel("环境检查失败",
                    "无法找到 Node.js\n\n" +
                    "请确保:\n" +
                    " Node.js 已安装 (可以在终端运行: node --version)\n" +
                    "如果自动检测 Node.js 失败，可以在终端运行以下命令获取 Node.js 路径，并粘贴到下面的输入框中:\n" +
                    "    node -p \"process.execPath\"\n\n" +
                    "当前检测到的 Node.js 路径: " + claudeSDKBridge.getNodeExecutable());
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
                    "1. Node.js 已安装 (可以在终端运行: node --version)\n" +
                    "2. claude-bridge 目录存在\n" +
                    "3. 已运行: cd claude-bridge && npm install\n\n" +
                    "如果自动检测 Node.js 失败，可以在终端运行以下命令获取 Node.js 路径，并粘贴到下面的输入框中:\n" +
                    "    node -p \"process.execPath\"\n\n" +
                    "检测到的 Node.js 路径: " + claudeSDKBridge.getNodeExecutable());
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

            // 底部：手动指定 Node.js 路径的输入框和按钮
            JPanel bottomPanel = new JPanel();
            bottomPanel.setLayout(new BoxLayout(bottomPanel, BoxLayout.Y_AXIS));
            bottomPanel.setBorder(BorderFactory.createEmptyBorder(10, 20, 20, 20));
            bottomPanel.setBackground(new Color(30, 30, 30));

            JLabel nodeLabel = new JLabel("Node.js 路径（可选：手动指定）:");
            nodeLabel.setForeground(Color.WHITE);

            JTextField nodeField = new JTextField();
            nodeField.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));

            // 预填充为已保存的路径或当前检测到的路径
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);
                if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                    nodeField.setText(savedNodePath.trim());
                } else {
                    String currentNode = claudeSDKBridge.getNodeExecutable();
                    if (currentNode != null) {
                        nodeField.setText(currentNode);
                    }
                }
            } catch (Exception e) {
                System.err.println("[ClaudeChatWindow] Failed to preload Node.js path: " + e.getMessage());
            }

            JButton saveAndRetryButton = new JButton("保存并重试");
            saveAndRetryButton.addActionListener(e -> {
                String manualPath = nodeField.getText();
                if (manualPath != null) {
                    manualPath = manualPath.trim();
                }

                try {
                    PropertiesComponent props = PropertiesComponent.getInstance();

                    if (manualPath == null || manualPath.isEmpty()) {
                        // 清除手动配置，恢复自动检测
                        props.unsetValue(NODE_PATH_PROPERTY_KEY);
                        claudeSDKBridge.setNodeExecutable(null);
                        System.out.println("[ClaudeChatWindow] Cleared manual Node.js path, fallback to auto-detection");
                    } else {
                        // 保存并应用手动路径
                        props.setValue(NODE_PATH_PROPERTY_KEY, manualPath);
                        claudeSDKBridge.setNodeExecutable(manualPath);
                        System.out.println("[ClaudeChatWindow] Saved manual Node.js path: " + manualPath);
                    }

                    // 重新尝试环境检查和界面初始化
                    SwingUtilities.invokeLater(() -> {
                        mainPanel.removeAll();
                        createUIComponents();
                        mainPanel.revalidate();
                        mainPanel.repaint();
                    });

                } catch (Exception ex) {
                    JOptionPane.showMessageDialog(mainPanel,
                        "保存或应用 Node.js 路径时出错: " + ex.getMessage(),
                        "错误",
                        JOptionPane.ERROR_MESSAGE);
                }
            });

            bottomPanel.add(nodeLabel);
            bottomPanel.add(Box.createRigidArea(new Dimension(0, 5)));
            bottomPanel.add(nodeField);
            bottomPanel.add(Box.createRigidArea(new Dimension(0, 10)));
            bottomPanel.add(saveAndRetryButton);

            errorPanel.add(bottomPanel, BorderLayout.SOUTH);

            mainPanel.add(errorPanel, BorderLayout.CENTER);
        }

        /**
         * 处理来自 JavaScript 的消息
         */
        private void handleJavaScriptMessage(String message) {
            // System.out.println("[Backend] ========== 收到 JS 消息 ==========");
            // System.out.println("[Backend] 原始消息: " + message);

            // 解析消息（简单的格式：type:content）
            String[] parts = message.split(":", 2);
            if (parts.length < 1) {
                System.err.println("[Backend] 错误: 消息格式无效");
                return;
            }

            String type = parts[0];
            String content = parts.length > 1 ? parts[1] : "";
            // System.out.println("[Backend] 消息类型: '" + type + "'");
            // System.out.println("[Backend] 消息内容: '" + content + "'");

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
                            // 移除通知：会话已中断
                        });
                    });
                    break;

                case "restart_session":
                    System.out.println("[Backend] 处理: restart_session");
                    session.restart().thenRun(() -> {
                        SwingUtilities.invokeLater(() -> {
                            // 移除通知：会话已重启
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
                    System.out.println("[PERM_DEBUG][BRIDGE_RECV] Received permission_decision from JS");
                    System.out.println("[PERM_DEBUG][BRIDGE_RECV] Content: " + content);
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

                case "get_current_claude_config":
                    System.out.println("[Backend] 处理: get_current_claude_config");
                    handleGetCurrentClaudeConfig();
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

                case "set_provider":
                    System.out.println("[Backend] 处理: set_provider");
                    handleSetProvider(content);
                    break;

	                case "get_node_path":
	                    System.out.println("[Backend] 处理: get_node_path");
	                    handleGetNodePath();
	                    break;

	                case "set_node_path":
	                    System.out.println("[Backend] 处理: set_node_path");
	                    handleSetNodePath(content);
	                    break;

	                // MCP 服务器管理
	                case "get_mcp_servers":
	                    System.out.println("[Backend] 处理: get_mcp_servers");
	                    handleGetMcpServers();
	                    break;

	                case "add_mcp_server":
	                    System.out.println("[Backend] 处理: add_mcp_server");
	                    handleAddMcpServer(content);
	                    break;

	                case "update_mcp_server":
	                    System.out.println("[Backend] 处理: update_mcp_server");
	                    handleUpdateMcpServer(content);
	                    break;

	                case "delete_mcp_server":
	                    System.out.println("[Backend] 处理: delete_mcp_server");
	                    handleDeleteMcpServer(content);
	                    break;

	                case "validate_mcp_server":
	                    System.out.println("[Backend] 处理: validate_mcp_server");
	                    handleValidateMcpServer(content);
	                    break;
                    // Skills 管理
                    case "get_all_skills":
                        System.out.println("[Backend] 处理: get_all_skills");
                        handleGetAllSkills();
                        break;

                    case "import_skill":
                        System.out.println("[Backend] 处理: import_skill");
                        handleImportSkill(content);
                        break;

                    case "delete_skill":
                        System.out.println("[Backend] 处理: delete_skill");
                        handleDeleteSkillNew(content);
                        break;

                    case "open_skill":
                        System.out.println("[Backend] 处理: open_skill");
                        handleOpenSkill(content);
                        break;

                    case "toggle_skill":
                        System.out.println("[Backend] 处理: toggle_skill");
                        handleToggleSkill(content);
                        break;

                    case "preview_cc_switch_import":
                        System.out.println("[Backend] 处理: preview_cc_switch_import");
                        handlePreviewCcSwitchImport();
                        break;

                    case "save_imported_providers":
                        System.out.println("[Backend] 处理: save_imported_providers");
                        handleSaveImportedProviders(content);
                        break;

                default:
                    System.err.println("[Backend] 警告: 未知的消息类型: " + type);
            }
            // System.out.println("[Backend] ========== 消息处理完成 ==========");
        }

        private void handlePreviewCcSwitchImport() {
            ApplicationManager.getApplication().invokeLater(() -> {
                // 1. 自动查找默认路径（使用跨平台路径分隔符）
                String userHome = System.getProperty("user.home");
                String osName = System.getProperty("os.name").toLowerCase();

                // 统一使用 File.separator 或直接用正斜杠（Java 在 Windows 上也支持）
                File ccSwitchDir = new File(userHome, ".cc-switch");
                File dbFile = new File(ccSwitchDir, "cc-switch.db");

                System.out.println("[Backend] 操作系统: " + osName);
                System.out.println("[Backend] 用户目录: " + userHome);
                System.out.println("[Backend] cc-switch 目录: " + ccSwitchDir.getAbsolutePath());
                System.out.println("[Backend] 数据库文件路径: " + dbFile.getAbsolutePath());
                System.out.println("[Backend] 数据库文件是否存在: " + dbFile.exists());

                if (!dbFile.exists()) {
                    String errorMsg = "未找到 cc-switch 数据库文件\n" +
                                     "路径: " + dbFile.getAbsolutePath() + "\n" +
                                     "请确保:\n" +
                                     "1. 已安装 cc-switch 3.8.2 及以上版本\n" +
                                     "2. 至少配置过一个 Claude 供应商";
                    System.err.println("[Backend] " + errorMsg);
                    sendErrorToFrontend("文件未找到", errorMsg);
                    return;
                }

                // 2. 异步读取并解析
                CompletableFuture.runAsync(() -> {
                    try {
                        System.out.println("[Backend] 开始读取数据库文件...");
                        Gson gson = new Gson();
                        List<JsonObject> providers = settingsService.parseProvidersFromCcSwitchDb(dbFile.getPath());

                        if (providers.isEmpty()) {
                            System.out.println("[Backend] 数据库中没有找到 Claude 供应商配置");
                            sendInfoToFrontend("无数据", "未在数据库中找到有效的 Claude 供应商配置。");
                            return;
                        }

                        // 3. 发送给前端预览
                        JsonArray providersArray = new JsonArray();
                        for (JsonObject p : providers) {
                            providersArray.add(p);
                        }

                        JsonObject response = new JsonObject();
                        response.add("providers", providersArray);

                        String jsonStr = gson.toJson(response);
                        System.out.println("[Backend] 成功读取 " + providers.size() + " 个供应商配置，准备发送到前端");
                        callJavaScript("import_preview_result", jsonStr);

                    } catch (Exception e) {
                        String errorDetails = "读取数据库失败: " + e.getMessage();
                        System.err.println("[Backend] " + errorDetails);
                        e.printStackTrace();
                        sendErrorToFrontend("读取数据库失败", errorDetails);
                    }
                });
            });
        }

        private void handleSaveImportedProviders(String content) {
            CompletableFuture.runAsync(() -> {
                try {
                    Gson gson = new Gson();
                    JsonObject request = gson.fromJson(content, JsonObject.class);
                    JsonArray providersArray = request.getAsJsonArray("providers");
                    
                    if (providersArray == null || providersArray.size() == 0) {
                        return;
                    }
                    
                    List<JsonObject> providers = new ArrayList<>();
                    for (JsonElement e : providersArray) {
                        if (e.isJsonObject()) {
                            providers.add(e.getAsJsonObject());
                        }
                    }
                    
                    int count = settingsService.saveProviders(providers);
                    
                    SwingUtilities.invokeLater(() -> {
                        handleGetProviders(); // 刷新界面
                        sendInfoToFrontend("导入成功", "成功导入 " + count + " 个配置。");
                    });
                    
                } catch (Exception e) {
                    e.printStackTrace();
                    sendErrorToFrontend("保存失败", e.getMessage());
                }
            });
        }
        
        private void sendInfoToFrontend(String title, String message) {
            // 这里可以封装一个通用的前端通知方法，或者复用 Messages.showInfoMessage 但用户不希望系统弹窗
            // 既然用户不希望系统弹窗，我们可以通过 callJavaScript 发送通知事件，让前端自己弹 toast
            // 假设前端有一个 handleNotification 之类的方法，或者直接用 postMessage
            // 这里为了简单，我们还是用 bridge 发送一个事件，让前端处理
             Gson gson = new Gson();
             JsonObject errorObj = new JsonObject();
             errorObj.addProperty("type", "info");
             errorObj.addProperty("title", title);
             errorObj.addProperty("message", message);
             callJavaScript("backend_notification", gson.toJson(errorObj));
        }

        private void sendErrorToFrontend(String title, String message) {
             Gson gson = new Gson();
             JsonObject errorObj = new JsonObject();
             errorObj.addProperty("type", "error");
             errorObj.addProperty("title", title);
             errorObj.addProperty("message", message);
             callJavaScript("backend_notification", gson.toJson(errorObj));
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
         * 1. 项目根目录（IDEA 打开的文件夹）- 这是最重要的，确保历史记录能正确关联
         * 2. 用户主目录（作为最后的 fallback）
         *
         * 注意：不再使用"当前打开文件的目录"，因为这会导致 Claude Code 的历史记录
         * 无法正确关联到 IDEA 项目。例如：用户打开 C:\project，但正在编辑
         * C:\project\src\sub\file.java，如果使用文件目录，历史会保存到
         * C--project-src-sub，而不是 C--project。
         */
        private String determineWorkingDirectory() {
            // 1. 优先使用项目根目录（IDEA 打开的文件夹）
            String projectPath = project.getBasePath();
            if (projectPath != null && new File(projectPath).exists()) {
                System.out.println("[ClaudeChatWindow] Using project base path: " + projectPath);
                return projectPath;
            }

            // 2. 最后使用用户主目录
            String userHome = System.getProperty("user.home");
            System.out.println("[ClaudeChatWindow] WARNING: Using user home directory as fallback: " + userHome);
            System.out.println("[ClaudeChatWindow] Files will be written to: " + userHome);

            // 移除通知：警告工作目录

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

            // 移除通知：正在加载历史会话...

            // 创建新的 Session 并设置会话信息
            session = new ClaudeSession(claudeSDKBridge, codexSDKBridge);
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
                    // 移除通知：会话已加载，可以继续提问
                });
            }).exceptionally(ex -> {
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("addErrorMessage", escapeJs("加载会话失败: " + ex.getMessage()));
                    // 移除通知：加载失败
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
                    // System.out.println("[ClaudeChatWindow] onMessageUpdate called with " + messages.size() + " messages");
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
                            // System.out.println("[ClaudeChatWindow] Message: type=" + msg.type +
                            //     ", content.length=" + (msg.content != null ? msg.content.length() : 0) +
                            //     ", hasRaw=" + (msg.raw != null));
                        }

                        String messagesJson = gson.toJson(messagesArray);
                        String escapedJson = escapeJs(messagesJson);

                        // 调用 JavaScript 更新消息
                    callJavaScript("updateMessages", escapedJson);
                });
                // System.out.println("[Backend] Pushing usage update from messages (real-time), messageCount=" + messages.size());
                pushUsageUpdateFromMessages(messages);
            }

                @Override
                public void onStateChange(boolean busy, boolean loading, String error) {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("showLoading", String.valueOf(busy));

                        if (error != null) {
                            callJavaScript("updateStatus", escapeJs("错误: " + error));
                        }
                        // 移除通知：正在处理...、加载中...、就绪
                    });
                }

                @Override
                public void onSessionIdReceived(String sessionId) {
                    SwingUtilities.invokeLater(() -> {
                        // 移除通知：会话 ID
                        System.out.println("Session ID: " + sessionId);
                    });
                }

                @Override
                public void onPermissionRequested(PermissionRequest request) {
                    SwingUtilities.invokeLater(() -> {
                        showPermissionDialog(request);
                    });
                }

                @Override
                public void onThinkingStatusChanged(boolean isThinking) {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("showThinkingStatus", String.valueOf(isThinking));
                        System.out.println("[ClaudeChatWindow] Thinking status changed: " + isThinking);
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
                    // System.out.println("[Backend] Last assistant usage -> input:" + inputTokens + ", output:" + outputTokens + ", cacheWrite:" + cacheWriteTokens + ", cacheRead:" + cacheReadTokens);
                }

                int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
                int maxTokens = MODEL_CONTEXT_LIMITS.getOrDefault(currentModel, 200_000);
                int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);
                // System.out.println("[Backend] 上下文=" + usedTokens + ", maxContext=" + maxTokens + ", percentage=" + percentage + "%");

                com.google.gson.Gson gson = new com.google.gson.Gson();
                com.google.gson.JsonObject usageUpdate = new com.google.gson.JsonObject();
                usageUpdate.addProperty("percentage", percentage);
                usageUpdate.addProperty("totalTokens", usedTokens);
                usageUpdate.addProperty("limit", maxTokens);
                usageUpdate.addProperty("usedTokens", usedTokens);
                usageUpdate.addProperty("maxTokens", maxTokens);
                String usageJson = gson.toJson(usageUpdate);

                javax.swing.SwingUtilities.invokeLater(() -> {
                    // System.out.println("[Backend] Calling window.onUsageUpdate with payload length=" + usageJson.length());
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

            // 移除通知：正在创建新会话...

            // 创建新的 Session 实例（不设置 sessionId，让 SDK 自动生成）
            session = new ClaudeSession(claudeSDKBridge, codexSDKBridge);
            setupSessionCallbacks();

            // 智能确定工作目录
            String workingDirectory = determineWorkingDirectory();
            session.setSessionInfo(null, workingDirectory);  // sessionId 为 null 表示新会话
            System.out.println("New session created with cwd: " + workingDirectory);

            // 移除通知：工作目录

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
                    // 移除通知：工作目录
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
                    // 移除通知：工作目录
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
                // 移除通知：权限被拒，已中断会话
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

            // 使用 ApplicationManager.invokeLater 并指定 NON_MODAL 来确保在正确的上下文中执行
            ApplicationManager.getApplication().invokeLater(() -> {
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
            }, ModalityState.NON_MODAL);
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
                            // 移除通知：已发送中断请求
                        }

                        // 重启会话
                        function restartSession() {
                            if (confirm('确定要重启会话吗？这将清空当前对话历史。')) {
                                window.sendToJava('restart_session:');
                                clearMessages();
                                // 移除通知：正在重启会话...
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

        // 存储待处理的权限请求（用于 PermissionService）
        private final Map<String, CompletableFuture<Integer>> pendingPermissionRequests = new ConcurrentHashMap<>();

        /**
         * 显示前端权限对话框（供 PermissionService 调用）
         */
        private CompletableFuture<Integer> showFrontendPermissionDialog(String toolName, JsonObject inputs) {
            String channelId = UUID.randomUUID().toString();
            CompletableFuture<Integer> future = new CompletableFuture<>();
            long startTime = System.currentTimeMillis();

            System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] Starting showFrontendPermissionDialog");
            System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] channelId=" + channelId + ", toolName=" + toolName);

            // 存储 future，等待前端返回决策
            pendingPermissionRequests.put(channelId, future);
            System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] Added to pendingPermissionRequests, size=" + pendingPermissionRequests.size());

            try {
                // 构建权限请求数据
                Gson gson = new Gson();
                JsonObject requestData = new JsonObject();
                requestData.addProperty("channelId", channelId);
                requestData.addProperty("toolName", toolName);
                requestData.add("inputs", inputs);

                String requestJson = gson.toJson(requestData);
                String escapedJson = escapeJs(requestJson);

                System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] Request JSON: " + requestJson);

                // 通过 JavaScript 桥接触发前端弹窗（带重试逻辑）
                SwingUtilities.invokeLater(() -> {
                    System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] Executing JS on EDT");
                    // 使用重试逻辑，确保前端已加载
                    String jsCode = "(function retryShowDialog(retries) { " +
                        "  console.log('[PERM_DEBUG][JS] retryShowDialog called, retries=' + retries); " +
                        "  if (window.showPermissionDialog) { " +
                        "    console.log('[PERM_DEBUG][JS] Calling showPermissionDialog'); " +
                        "    window.showPermissionDialog('" + escapedJson + "'); " +
                        "  } else if (retries > 0) { " +
                        "    console.log('[PERM_DEBUG][JS] Waiting for showPermissionDialog, retries=' + retries); " +
                        "    setTimeout(function() { retryShowDialog(retries - 1); }, 200); " +
                        "  } else { " +
                        "    console.error('[PERM_DEBUG][JS] FAILED: showPermissionDialog not available after all retries!'); " +
                        "  } " +
                        "})(30);"; // 最多重试30次，每次200ms，总共6秒

                    browser.getCefBrowser().executeJavaScript(jsCode, browser.getCefBrowser().getURL(), 0);
                    System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] JS executed, waiting for user response");
                });

                // 设置超时处理
                CompletableFuture.delayedExecutor(35, TimeUnit.SECONDS).execute(() -> {
                    if (!future.isDone()) {
                        long elapsed = System.currentTimeMillis() - startTime;
                        System.err.println("[PERM_DEBUG][FRONTEND_DIALOG] TIMEOUT after " + elapsed + "ms, channelId=" + channelId);
                        pendingPermissionRequests.remove(channelId);
                        future.complete(PermissionService.PermissionResponse.DENY.getValue());
                    }
                });

            } catch (Exception e) {
                System.err.println("[PERM_DEBUG][FRONTEND_DIALOG] ERROR: " + e.getMessage());
                e.printStackTrace();
                pendingPermissionRequests.remove(channelId);
                future.complete(PermissionService.PermissionResponse.DENY.getValue());
            }

            return future;
        }

        /**
         * 显示权限请求对话框（通过前端 WebView）
         */
        private void showPermissionDialog(PermissionRequest request) {
            System.out.println("[Backend] 显示权限请求对话框: " + request.getToolName());

            try {
                // 构建权限请求数据
                Gson gson = new Gson();
                JsonObject requestData = new JsonObject();
                requestData.addProperty("channelId", request.getChannelId());
                requestData.addProperty("toolName", request.getToolName());

                // 转换 inputs 为 JsonObject
                JsonObject inputsJson = gson.toJsonTree(request.getInputs()).getAsJsonObject();
                requestData.add("inputs", inputsJson);

                // 添加 suggestions（如果有）
                if (request.getSuggestions() != null) {
                    requestData.add("suggestions", request.getSuggestions());
                }

                String requestJson = gson.toJson(requestData);
                String escapedJson = escapeJs(requestJson);

                System.out.println("[Backend] 权限请求数据: " + requestJson);

                // 通过 JavaScript 桥接触发前端弹窗
                SwingUtilities.invokeLater(() -> {
                    String jsCode = "if (window.showPermissionDialog) { " +
                        "  console.log('[Backend->Frontend] Showing permission dialog'); " +
                        "  window.showPermissionDialog('" + escapedJson + "'); " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] window.showPermissionDialog not available!'); " +
                        "}";

                    browser.getCefBrowser().executeJavaScript(jsCode, browser.getCefBrowser().getURL(), 0);
                    System.out.println("[Backend] 已触发前端权限弹窗");
                });

            } catch (Exception e) {
                System.err.println("[Backend] 显示权限弹窗失败: " + e.getMessage());
                e.printStackTrace();

                // 如果前端弹窗失败，自动拒绝权限请求
                session.handlePermissionDecision(
                    request.getChannelId(),
                    false,
                    false,
                    "Failed to show permission dialog: " + e.getMessage()
                );
                interruptDueToPermissionDenial();
            }
        }

        /**
         * 处理来自JavaScript的权限决策消息
         */
        private void handlePermissionDecision(String jsonContent) {
            System.out.println("[PERM_DEBUG][HANDLE_DECISION] Received decision from JS: " + jsonContent);
            try {
                Gson gson = new Gson();
                JsonObject decision = gson.fromJson(jsonContent, JsonObject.class);

                String channelId = decision.get("channelId").getAsString();
                boolean allow = decision.get("allow").getAsBoolean();
                boolean remember = decision.get("remember").getAsBoolean();
                // 修复：检查 rejectMessage 是否为 null 或 JsonNull
                String rejectMessage = "";
                if (decision.has("rejectMessage") && !decision.get("rejectMessage").isJsonNull()) {
                    rejectMessage = decision.get("rejectMessage").getAsString();
                }

                System.out.println("[PERM_DEBUG][HANDLE_DECISION] Parsed: channelId=" + channelId + ", allow=" + allow + ", remember=" + remember);
                System.out.println("[PERM_DEBUG][HANDLE_DECISION] pendingPermissionRequests size before: " + pendingPermissionRequests.size());

                // 检查是否是 PermissionService 的请求
                CompletableFuture<Integer> pendingFuture = pendingPermissionRequests.remove(channelId);
                System.out.println("[PERM_DEBUG][HANDLE_DECISION] pendingFuture found: " + (pendingFuture != null));

                if (pendingFuture != null) {
                    // 这是来自 PermissionService 的请求
                    System.out.println("[PERM_DEBUG][HANDLE_DECISION] Processing as PermissionService request");
                    int responseValue;
                    if (allow) {
                        responseValue = remember ?
                            PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue() :
                            PermissionService.PermissionResponse.ALLOW.getValue();
                    } else {
                        responseValue = PermissionService.PermissionResponse.DENY.getValue();
                    }
                    System.out.println("[PERM_DEBUG][HANDLE_DECISION] Completing future with value: " + responseValue);
                    pendingFuture.complete(responseValue);

                    if (!allow) {
                        System.out.println("[PERM_DEBUG][HANDLE_DECISION] Permission denied, interrupting");
                        interruptDueToPermissionDenial();
                    }
                } else {
                    // 这是来自 ClaudeSession 的请求
                    System.out.println("[PERM_DEBUG][HANDLE_DECISION] Processing as ClaudeSession request");
                    if (remember) {
                        // 总是允许/拒绝
                        session.handlePermissionDecisionAlways(channelId, allow);
                    } else {
                        // 仅此次允许/拒绝
                        session.handlePermissionDecision(channelId, allow, false, rejectMessage);
                    }
                    if (!allow) {
                        System.out.println("[PERM_DEBUG][HANDLE_DECISION] Permission denied, interrupting");
                        interruptDueToPermissionDenial();
                    }
                }
                System.out.println("[PERM_DEBUG][HANDLE_DECISION] Decision handling complete");
            } catch (Exception e) {
                System.err.println("[PERM_DEBUG][HANDLE_DECISION] ERROR: " + e.getMessage());
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
         * 获取当前 Claude CLI 配置 (~/.claude/settings.json)
         */
        private void handleGetCurrentClaudeConfig() {
            try {
                JsonObject config = settingsService.getCurrentClaudeConfig();
                Gson gson = new Gson();
                String configJson = gson.toJson(config);

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateCurrentClaudeConfig", escapeJs(configJson));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to get current claude config: " + e.getMessage());
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
                    // 移除通知：供应商添加成功
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
                    // 移除通知：供应商更新成功
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
                        // 移除通知：供应商删除成功
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
                    // 使用 WebView 弹窗替代系统 alert
                    callJavaScript("window.showSwitchSuccess", escapeJs("供应商切换成功！\n\n已自动同步到 ~/.claude/settings.json，下一次提问将使用新的配置。"));
                    handleGetProviders(); // 刷新供应商列表
                    handleGetCurrentClaudeConfig(); // 刷新 Claude CLI 配置显示
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

                    // System.out.println("[Backend] Getting usage statistics for path: " + projectPath);

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
                        // System.out.println("[Backend] updateUsageStatistics: tokens=" + tokensFinal + ", limit=" + limitFinal + ", percentage=" + percentageFinal + "% (not pushing onUsageUpdate)");
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
                                // 跳过大型忽略目录，保留普通隐藏文件
                                if (name.equals(".git") || name.equals(".svn") || name.equals(".hg") ||
                                    name.equals("node_modules") || name.equals("dist") || name.equals("out")) {
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

                    // 排序：按照 IDE 文件树顺序
                    // 1. 路径深度优先（浅层在前）
                    // 2. 同一父目录下的项目聚在一起
                    // 3. 目录优先于文件
                    // 4. 按名称自然排序
                    files.sort((a, b) -> {
                        String aPath = a.get("path").getAsString();
                        String bPath = b.get("path").getAsString();
                        boolean aDir = "directory".equals(a.get("type").getAsString());
                        boolean bDir = "directory".equals(b.get("type").getAsString());
                        String aName = a.get("name").getAsString();
                        String bName = b.get("name").getAsString();

                        // 计算路径深度
                        int aDepth = aPath.split("/").length;
                        int bDepth = bPath.split("/").length;

                        // 1. 浅层优先
                        if (aDepth != bDepth) return aDepth - bDepth;

                        // 2. 同一父目录下分组
                        String aParent = aPath.contains("/") ? aPath.substring(0, aPath.lastIndexOf('/')) : "";
                        String bParent = bPath.contains("/") ? bPath.substring(0, bPath.lastIndexOf('/')) : "";
                        int parentCompare = aParent.compareToIgnoreCase(bParent);
                        if (parentCompare != 0) return parentCompare;

                        // 3. 目录优先
                        if (aDir != bDir) return aDir ? -1 : 1;

                        // 4. 按名称自然排序
                        return aName.compareToIgnoreCase(bName);
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
                // 跳过常见的忽略目录（保留普通隐藏文件/文件夹，但跳过 .git 等大型目录）
                if (name.equals(".git") ||
                    name.equals(".svn") ||
                    name.equals(".hg") ||
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

                // 移除通知：权限模式已设置
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

                // 更新 session 的模型
                if (session != null) {
                    session.setModel(model);
                }

                // 移除通知：模型已设置
            } catch (Exception e) {
                System.err.println("[Backend] Failed to set model: " + e.getMessage());
                e.printStackTrace();
            }
        }

        /**
         * 处理设置提供商请求
         */
        private void handleSetProvider(String content) {
            try {
                String provider = content;
                if (content != null && !content.isEmpty()) {
                    try {
                        Gson gson = new Gson();
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("provider")) {
                            provider = json.get("provider").getAsString();
                        }
                    } catch (Exception e) {
                        // content 本身就是 provider
                    }
                }

                System.out.println("[Backend] Setting provider to: " + provider);
                this.currentProvider = provider;

                // 更新 session 的提供商
                if (session != null) {
                    session.setProvider(provider);
                }

                // 移除通知：提供商已设置
            } catch (Exception e) {
                System.err.println("[Backend] Failed to set provider: " + e.getMessage());
                e.printStackTrace();
            }
        }

	    	private void handleGetNodePath() {
	    	    try {
	    	        PropertiesComponent props = PropertiesComponent.getInstance();
	    	        String saved = props.getValue(NODE_PATH_PROPERTY_KEY);
	    	        String effectivePath;
	    	        if (saved != null && !saved.trim().isEmpty()) {
	    	            effectivePath = saved.trim();
	    	        } else {
	    	            // 如果没有手动配置，则返回当前检测到的 Node 路径（可能为空字符串）
	    	            String detected = claudeSDKBridge.getNodeExecutable();
	    	            effectivePath = detected != null ? detected : "";
	    	        }
	    	        final String pathToSend = effectivePath != null ? effectivePath : "";
	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.updateNodePath", escapeJs(pathToSend));
	    	        });
	    	    } catch (Exception e) {
	    	        System.err.println("[Backend] Failed to get Node.js path: " + e.getMessage());
	    	        e.printStackTrace();
	    	    }
	    	}

	    	private void handleSetNodePath(String content) {
	    	    System.out.println("[Backend] ========== handleSetNodePath START ==========");
	    	    System.out.println("[Backend] Received content: " + content);
	    	    try {
	    	        Gson gson = new Gson();
	    	        JsonObject json = gson.fromJson(content, JsonObject.class);
	    	        String path = null;
	    	        if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
	    	            path = json.get("path").getAsString();
	    	        }

	    	        if (path != null) {
	    	            path = path.trim();
	    	        }

	    	        PropertiesComponent props = PropertiesComponent.getInstance();
	    	        String effectivePath;
	    	        if (path == null || path.isEmpty()) {
	    	            // 清除手动配置，恢复自动检测
	    	            props.unsetValue(NODE_PATH_PROPERTY_KEY);
	    	            claudeSDKBridge.setNodeExecutable(null);
	    	            System.out.println("[Backend] Cleared manual Node.js path from settings (auto-detection will be used)");
	    	            String detected = claudeSDKBridge.getNodeExecutable();
	    	            effectivePath = detected != null ? detected : "";
	    	        } else {
	    	            props.setValue(NODE_PATH_PROPERTY_KEY, path);
	    	            claudeSDKBridge.setNodeExecutable(path);
	    	            System.out.println("[Backend] Updated manual Node.js path from settings: " + path);
	    	            effectivePath = path;
	    	        }

	    	        final String finalPath = effectivePath != null ? effectivePath : "";
	    	        SwingUtilities.invokeLater(() -> {
	    	            // 更新前端显示的 Node.js 路径
	    	            callJavaScript("window.updateNodePath", escapeJs(finalPath));
	    	            // 使用现有的成功提示通道，给出保存成功信息
	    	            callJavaScript("window.showSwitchSuccess", escapeJs("Node.js 路径已保存。\n\n如果环境检查仍然失败，请关闭并重新打开工具窗口后重试。"));
	    	        });
	    	    } catch (Exception e) {
	    	        System.err.println("[Backend] Failed to set Node.js path: " + e.getMessage());
	    	        e.printStackTrace();
	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.showError", escapeJs("保存 Node.js 路径失败: " + e.getMessage()));
	    	        });
	    	    }
	    	    System.out.println("[Backend] ========== handleSetNodePath END ==========");
	    	}

	    	// ==================== MCP 服务器管理 Handler ====================

	    	/**
	    	 * 获取所有 MCP 服务器
	    	 */
	    	private void handleGetMcpServers() {
	    	    try {
	    	        List<JsonObject> servers = settingsService.getMcpServers();
	    	        Gson gson = new Gson();
	    	        String serversJson = gson.toJson(servers);

	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.updateMcpServers", escapeJs(serversJson));
	    	        });
	    	    } catch (Exception e) {
	    	        System.err.println("[Backend] Failed to get MCP servers: " + e.getMessage());
	    	        e.printStackTrace();
	    	    }
	    	}

	    	/**
	    	 * 添加 MCP 服务器
	    	 */
	    	private void handleAddMcpServer(String content) {
	    	    try {
	    	        Gson gson = new Gson();
	    	        JsonObject server = gson.fromJson(content, JsonObject.class);

	    	        settingsService.upsertMcpServer(server);

	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.mcpServerAdded", escapeJs(content));
	    	            // 刷新服务器列表
	    	            handleGetMcpServers();
	    	        });
	    	    } catch (Exception e) {
	    	        System.err.println("[Backend] Failed to add MCP server: " + e.getMessage());
	    	        e.printStackTrace();
	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.showError", escapeJs("添加 MCP 服务器失败: " + e.getMessage()));
	    	        });
	    	    }
	    	}

	    	/**
	    	 * 更新 MCP 服务器
	    	 */
	    	private void handleUpdateMcpServer(String content) {
	    	    try {
	    	        Gson gson = new Gson();
	    	        JsonObject server = gson.fromJson(content, JsonObject.class);

	    	        settingsService.upsertMcpServer(server);

	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.mcpServerUpdated", escapeJs(content));
	    	            // 刷新服务器列表
	    	            handleGetMcpServers();
	    	        });
	    	    } catch (Exception e) {
	    	        System.err.println("[Backend] Failed to update MCP server: " + e.getMessage());
	    	        e.printStackTrace();
	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.showError", escapeJs("更新 MCP 服务器失败: " + e.getMessage()));
	    	        });
	    	    }
	    	}

	    	/**
	    	 * 删除 MCP 服务器
	    	 */
	    	private void handleDeleteMcpServer(String content) {
	    	    try {
	    	        Gson gson = new Gson();
	    	        JsonObject json = gson.fromJson(content, JsonObject.class);
	    	        String serverId = json.get("id").getAsString();

	    	        boolean success = settingsService.deleteMcpServer(serverId);

	    	        if (success) {
	    	            SwingUtilities.invokeLater(() -> {
	    	                callJavaScript("window.mcpServerDeleted", escapeJs(serverId));
	    	                // 刷新服务器列表
	    	                handleGetMcpServers();
	    	            });
	    	        } else {
	    	            SwingUtilities.invokeLater(() -> {
	    	                callJavaScript("window.showError", escapeJs("删除 MCP 服务器失败: 服务器不存在"));
	    	            });
	    	        }
	    	    } catch (Exception e) {
	    	        System.err.println("[Backend] Failed to delete MCP server: " + e.getMessage());
	    	        e.printStackTrace();
	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.showError", escapeJs("删除 MCP 服务器失败: " + e.getMessage()));
	    	        });
	    	    }
	    	}

	    	/**
	    	 * 验证 MCP 服务器配置
	    	 */
	    	private void handleValidateMcpServer(String content) {
	    	    try {
	    	        Gson gson = new Gson();
	    	        JsonObject server = gson.fromJson(content, JsonObject.class);

	    	        Map<String, Object> validation = settingsService.validateMcpServer(server);
	    	        String validationJson = gson.toJson(validation);

	    	        SwingUtilities.invokeLater(() -> {
	    	            callJavaScript("window.mcpServerValidated", escapeJs(validationJson));
	    	        });
	    	    } catch (Exception e) {
	    	        System.err.println("[Backend] Failed to validate MCP server: " + e.getMessage());
	    	        e.printStackTrace();
	    	    }
	    	}

        // ==================== Skills Handler ====================

        /**
         * 获取所有 Skills (全局 + 本地)
         */
        private void handleGetAllSkills() {
            try {
                String workspaceRoot = project.getBasePath();
                JsonObject skills = SkillService.getAllSkills(workspaceRoot);
                Gson gson = new Gson();
                String skillsJson = gson.toJson(skills);

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateSkills", escapeJs(skillsJson));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to get all skills: " + e.getMessage());
                e.printStackTrace();
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateSkills", escapeJs("{\"global\":{},\"local\":{}}"));
                });
            }
        }

        /**
         * 导入 Skill（显示文件选择对话框）
         */
        private void handleImportSkill(String content) {
            try {
                Gson gson = new Gson();
                JsonObject json = gson.fromJson(content, JsonObject.class);
                String scope = json.has("scope") ? json.get("scope").getAsString() : "global";

                // 显示文件选择对话框（在 EDT 线程中）
                SwingUtilities.invokeLater(() -> {
                    javax.swing.JFileChooser chooser = new javax.swing.JFileChooser();
                    chooser.setDialogTitle("选择 Skill 文件或文件夹");
                    chooser.setFileSelectionMode(javax.swing.JFileChooser.FILES_AND_DIRECTORIES);
                    chooser.setMultiSelectionEnabled(true);

                    int result = chooser.showOpenDialog(mainPanel);
                    if (result == javax.swing.JFileChooser.APPROVE_OPTION) {
                        java.io.File[] selectedFiles = chooser.getSelectedFiles();
                        java.util.List<String> paths = new java.util.ArrayList<>();
                        for (java.io.File file : selectedFiles) {
                            paths.add(file.getAbsolutePath());
                        }

                        // 在后台线程中执行导入
                        CompletableFuture.runAsync(() -> {
                            try {
                                String workspaceRoot = project.getBasePath();
                                JsonObject importResult = SkillService.importSkills(paths, scope, workspaceRoot);
                                String resultJson = new Gson().toJson(importResult);

                                SwingUtilities.invokeLater(() -> {
                                    callJavaScript("window.skillImportResult", escapeJs(resultJson));
                                });
                            } catch (Exception e) {
                                System.err.println("[Backend] Import skill failed: " + e.getMessage());
                                JsonObject errorResult = new JsonObject();
                                errorResult.addProperty("success", false);
                                errorResult.addProperty("error", e.getMessage());
                                SwingUtilities.invokeLater(() -> {
                                    callJavaScript("window.skillImportResult", escapeJs(new Gson().toJson(errorResult)));
                                });
                            }
                        });
                    }
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to handle import skill: " + e.getMessage());
                e.printStackTrace();
            }
        }

        /**
         * 删除 Skill（新版本，支持启用/停用状态）
         */
        private void handleDeleteSkillNew(String content) {
            try {
                Gson gson = new Gson();
                JsonObject json = gson.fromJson(content, JsonObject.class);
                String skillName = json.get("name").getAsString();
                String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
                boolean enabled = json.has("enabled") ? json.get("enabled").getAsBoolean() : true;
                String workspaceRoot = project.getBasePath();

                JsonObject result = SkillService.deleteSkill(skillName, scope, enabled, workspaceRoot);
                String resultJson = gson.toJson(result);

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.skillDeleteResult", escapeJs(resultJson));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to delete skill: " + e.getMessage());
                e.printStackTrace();
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("error", e.getMessage());
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.skillDeleteResult", escapeJs(new Gson().toJson(errorResult)));
                });
            }
        }

        /**
         * 启用/停用 Skill
         */
        private void handleToggleSkill(String content) {
            try {
                Gson gson = new Gson();
                JsonObject json = gson.fromJson(content, JsonObject.class);
                String skillName = json.get("name").getAsString();
                String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
                boolean currentEnabled = json.has("enabled") ? json.get("enabled").getAsBoolean() : true;
                String workspaceRoot = project.getBasePath();

                // 调用 toggleSkill，它会根据当前状态决定是启用还是停用
                JsonObject result = SkillService.toggleSkill(skillName, scope, currentEnabled, workspaceRoot);
                String resultJson = gson.toJson(result);

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.skillToggleResult", escapeJs(resultJson));
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to toggle skill: " + e.getMessage());
                e.printStackTrace();
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("error", e.getMessage());
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.skillToggleResult", escapeJs(new Gson().toJson(errorResult)));
                });
            }
        }

        /**
         * 在编辑器中打开 Skill
         */
        private void handleOpenSkill(String content) {
            try {
                Gson gson = new Gson();
                JsonObject json = gson.fromJson(content, JsonObject.class);
                String skillPath = json.get("path").getAsString();

                java.io.File skillFile = new java.io.File(skillPath);
                String targetPath = skillPath;

                // 如果是目录，尝试打开 skill.md 或 SKILL.md
                if (skillFile.isDirectory()) {
                    java.io.File skillMd = new java.io.File(skillFile, "skill.md");
                    if (!skillMd.exists()) {
                        skillMd = new java.io.File(skillFile, "SKILL.md");
                    }
                    if (skillMd.exists()) {
                        targetPath = skillMd.getAbsolutePath();
                    }
                }

                // 在 IDEA 中打开文件
                final String fileToOpen = targetPath;
                ApplicationManager.getApplication().invokeLater(() -> {
                    VirtualFile virtualFile = LocalFileSystem.getInstance().findFileByPath(fileToOpen);
                    if (virtualFile != null) {
                        FileEditorManager.getInstance(project).openFile(virtualFile, true);
                    } else {
                        System.err.println("[Backend] Cannot find file: " + fileToOpen);
                    }
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to open skill: " + e.getMessage());
                e.printStackTrace();
            }
        }

	    	public JPanel getContent() {
	    	    return mainPanel;
	    	}

        /**
         * 接收选中的代码信息并发送到聊天窗口
         */
        private void addSelectionInfo(String selectionInfo) {
            if (selectionInfo == null || selectionInfo.isEmpty()) {
                return;
            }

            // 调用JavaScript函数将选中信息添加到聊天
            callJavaScript("addSelectionInfo", escapeJs(selectionInfo));
        }

        /**
         * 静态方法，用于从外部添加选中的代码信息（内部调用）
         */
        static void addSelectionFromExternalInternal(String selectionInfo) {
            if (instance != null) {
                instance.addSelectionInfo(selectionInfo);
            }
        }
    }
}
