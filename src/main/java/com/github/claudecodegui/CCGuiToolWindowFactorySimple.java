package com.github.claudecodegui;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefJSQuery;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.LocalFileSystem;

import javax.swing.*;
import java.awt.*;
import java.util.List;
import java.io.File;

/**
 * 历史会话工具窗口工厂类（简化版）
 */
public class CCGuiToolWindowFactorySimple implements ToolWindowFactory {

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        String projectPath = project.getBasePath();
        CCGuiToolWindow ccGuiToolWindow = new CCGuiToolWindow(project, projectPath);
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(
                ccGuiToolWindow.getContent(),
                "Claude History",
                false
        );
        toolWindow.getContentManager().addContent(content);
    }

    private static class CCGuiToolWindow {
        private JPanel mainPanel;
        private ClaudeHistoryReader historyReader;
        private String projectPath;
        private Project project;
        private JBCefBrowser browser;

        public CCGuiToolWindow(Project project, String projectPath) {
            this.project = project;
            this.projectPath = projectPath;
            this.historyReader = new ClaudeHistoryReader();
            createUIComponents();
        }

        private void createUIComponents() {
            mainPanel = new JPanel(new BorderLayout());

            try {
                browser = new JBCefBrowser();

                // 创建 JavaScript 桥接
                JBCefJSQuery jsQuery = JBCefJSQuery.create(browser);

                // 处理来自 JavaScript 的消息
                jsQuery.addHandler((msg) -> {
                    handleJavaScriptMessage(msg);
                    return new JBCefJSQuery.Response("ok");
                });

                // 获取当前项目的数据
                String jsonData = historyReader.getProjectDataAsJson(projectPath);

                // 生成HTML
                String htmlContent = generateHtmlWithData(jsonData);

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

                // 加载HTML
                browser.loadHTML(htmlContent);

                mainPanel.add(browser.getComponent(), BorderLayout.CENTER);

            } catch (Exception e) {
                // 备用显示
                JTextArea textArea = new JTextArea();
                textArea.setEditable(false);
                textArea.setFont(new Font("Monospaced", Font.PLAIN, 12));

                try {
                    String jsonData = historyReader.getProjectDataAsJson(projectPath);
                    textArea.setText("Claude历史数据 (JSON格式):\n\n" + jsonData);
                } catch (Exception ex) {
                    textArea.setText("无法加载数据: " + ex.getMessage());
                }

                mainPanel.add(new JScrollPane(textArea), BorderLayout.CENTER);
            }
        }

        /**
         * 处理来自 JavaScript 的消息
         */
        private void handleJavaScriptMessage(String message) {
            System.out.println("收到 JS 消息: " + message);

            // 解析消息（格式：type:content）
            String[] parts = message.split(":", 2);
            if (parts.length < 1) return;

            String type = parts[0];
            String content = parts.length > 1 ? parts[1] : "";

            switch (type) {
                case "load_session":
                    loadSessionById(content);
                    break;
                case "open_file":
                    openFileInEditor(content);
                    break;
                case "back_to_list":
                    // 返回会话列表（重新加载主页面）
                    SwingUtilities.invokeLater(() -> {
                        String jsonData = historyReader.getProjectDataAsJson(projectPath);
                        String htmlContent = generateHtmlWithData(jsonData);
                        browser.loadHTML(htmlContent);
                    });
                    break;
            }
        }

        /**
         * 通过 sessionId 加载会话
         */
        private void loadSessionById(String sessionId) {
            System.out.println("请求加载会话: " + sessionId);

            // 通过 SessionLoadService 通知 Claude Code GUI 加载会话
            SessionLoadService.getInstance().requestLoadSession(sessionId, projectPath);

            // 切换到 Claude Code GUI 工具窗口
            SwingUtilities.invokeLater(() -> {
                try {
                    ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
                    ToolWindow claudeChatWindow = toolWindowManager.getToolWindow("Claude Code GUI");
                    if (claudeChatWindow != null) {
                        claudeChatWindow.activate(null);
                    }
                } catch (Exception e) {
                    System.err.println("无法激活 Claude Code GUI 窗口: " + e.getMessage());
                    e.printStackTrace();
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
                    if (!file.exists()) {
                        System.err.println("文件不存在: " + filePath);
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

        private String generateHtmlWithData(String jsonData) {
            // 正确的转义顺序很重要！
            String escapedJson = jsonData
                .replace("\\", "\\\\")  // 先转义反斜杠
                .replace("\"", "\\\"")  // 再转义双引号
                .replace("'", "\\'")    // 转义单引号
                .replace("\n", "\\n")   // 转义换行
                .replace("\r", "\\r");  // 转义回车

            StringBuilder html = new StringBuilder();
            html.append("<!DOCTYPE html>\n");
            html.append("<html>\n");
            html.append("<head>\n");
            html.append("<meta charset=\"UTF-8\">\n");
            html.append("<script src=\"https://unpkg.com/vue@3/dist/vue.global.js\"></script>\n");
            html.append("<style>\n");
            html.append(":root {\n");
            html.append("  --bg-color: #1e1e1e;\n");
            html.append("  --card-bg: #252526;\n");
            html.append("  --text-primary: #cccccc;\n");
            html.append("  --text-secondary: #858585;\n");
            html.append("  --accent-color: #4a90e2;\n");
            html.append("  --border-color: #3e3e42;\n");
            html.append("  --user-msg-bg: #2d2d2d;\n");
            html.append("  --ai-msg-bg: #252526;\n");
            html.append("}\n");
            html.append("body {\n");
            html.append("  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;\n");
            html.append("  background: var(--bg-color);\n");
            html.append("  color: var(--text-primary);\n");
            html.append("  margin: 0;\n");
            html.append("  padding: 0;\n");
            html.append("  height: 100vh;\n");
            html.append("  display: flex;\n");
            html.append("  flex-direction: column;\n");
            html.append("}\n");
            html.append(".header {\n");
            html.append("  padding: 16px;\n");
            html.append("  background: var(--card-bg);\n");
            html.append("  border-bottom: 1px solid var(--border-color);\n");
            html.append("  position: sticky;\n");
            html.append("  top: 0;\n");
            html.append("  z-index: 100;\n");
            html.append("}\n");
            html.append("h1 {\n");
            html.append("  font-size: 18px;\n");
            html.append("  margin: 0 0 8px 0;\n");
            html.append("  color: var(--text-primary);\n");
            html.append("  display: flex;\n");
            html.append("  align-items: center;\n");
            html.append("  gap: 8px;\n");
            html.append("}\n");
            html.append(".project-path {\n");
            html.append("  font-size: 12px;\n");
            html.append("  color: var(--text-secondary);\n");
            html.append("  word-break: break-all;\n");
            html.append("}\n");
            html.append(".stats {\n");
            html.append("  display: flex;\n");
            html.append("  gap: 16px;\n");
            html.append("  font-size: 12px;\n");
            html.append("  color: var(--text-secondary);\n");
            html.append("  margin-top: 8px;\n");
            html.append("}\n");
            html.append(".message-list {\n");
            html.append("  flex: 1;\n");
            html.append("  overflow-y: auto;\n");
            html.append("  padding: 16px;\n");
            html.append("}\n");
            html.append(".message-item {\n");
            html.append("  background: var(--card-bg);\n");
            html.append("  border: 1px solid #3e3e42;\n");
            html.append("  border-radius: 8px;\n");
            html.append("  padding: 16px;\n");
            html.append("  margin-bottom: 12px;\n");
            html.append("  transition: background-color 0.2s;\n");
            html.append("  cursor: pointer;\n");
            html.append("}\n");
            html.append(".message-item:hover {\n");
            html.append("  background: #2d2d2d;\n");
            html.append("}\n");
            html.append(".message-header {\n");
            html.append("  display: flex;\n");
            html.append("  justify-content: space-between;\n");
            html.append("  margin-bottom: 24px;\n");
            html.append("}\n");
            html.append(".message-title {\n");
            html.append("  font-size: 15px;\n");
            html.append("  font-weight: 600;\n");
            html.append("  color: #e0e0e0;\n");
            html.append("  white-space: nowrap;\n");
            html.append("  overflow: hidden;\n");
            html.append("  text-overflow: ellipsis;\n");
            html.append("  margin-right: 16px;\n");
            html.append("  flex: 1;\n");
            html.append("}\n");
            html.append(".message-time {\n");
            html.append("  font-size: 13px;\n");
            html.append("  color: #858585;\n");
            html.append("  white-space: nowrap;\n");
            html.append("}\n");
            html.append(".message-footer {\n");
            html.append("  display: flex;\n");
            html.append("  justify-content: space-between;\n");
            html.append("  align-items: center;\n");
            html.append("  font-size: 13px;\n");
            html.append("  color: #858585;\n");
            html.append("}\n");
            html.append(".message-id {\n");
            html.append("  font-family: monospace;\n");
            html.append("  color: #666;\n");
            html.append("}\n");
            html.append(".empty-state {\n");
            html.append("  display: flex;\n");
            html.append("  flex-direction: column;\n");
            html.append("  align-items: center;\n");
            html.append("  justify-content: center;\n");
            html.append("  height: 100%;\n");
            html.append("  color: var(--text-secondary);\n");
            html.append("  text-align: center;\n");
            html.append("}\n");
            html.append("::-webkit-scrollbar {\n");
            html.append("  width: 8px;\n");
            html.append("}\n");
            html.append("::-webkit-scrollbar-track {\n");
            html.append("  background: var(--bg-color);\n");
            html.append("}\n");
            html.append("::-webkit-scrollbar-thumb {\n");
            html.append("  background: #424242;\n");
            html.append("  border-radius: 4px;\n");
            html.append("}\n");
            html.append("::-webkit-scrollbar-thumb:hover {\n");
            html.append("  background: #4f4f4f;\n");
            html.append("}\n");
            html.append("</style>\n");
            html.append("</head>\n");
            html.append("<body>\n");
            html.append("<div id=\"app\">\n");

            // 头部区域
            html.append("  <div class=\"header\">\n");
            html.append("    <h1>历史会话</h1>\n");
            html.append("    <div class=\"project-path\" v-if=\"data && data.currentProject\">\n");
            html.append("      {{ data.currentProject }}\n");
            html.append("    </div>\n");
            html.append("    <div class=\"stats\" v-if=\"data && data.success\">\n");
            html.append("      <span>📝 {{ data.sessions ? data.sessions.length : 0 }} 个会话</span>\n");
            html.append("      <span>💬 {{ data.total || 0 }} 条消息</span>\n");
            html.append("    </div>\n");
            html.append("  </div>\n");

            // 内容区域
            html.append("  <div class=\"message-list\" v-if=\"data && data.sessions && data.sessions.length > 0\">\n");
            html.append("    <div v-for=\"session in data.sessions\" :key=\"session.sessionId\" class=\"message-item\" @click=\"loadSession(session.sessionId)\">\n");
            html.append("      <div class=\"message-header\">\n");
            html.append("        <div class=\"message-title\">{{ session.title }}</div>\n");
            html.append("        <div class=\"message-time\">{{ timeAgo(session.lastTimestamp) }}</div>\n");
            html.append("      </div>\n");
            html.append("      <div class=\"message-footer\">\n");
            html.append("        <span>{{ session.messageCount }} 条消息</span>\n");
            html.append("        <span class=\"message-id\">{{ session.sessionId.substring(0, 8) }}</span>\n");
            html.append("      </div>\n");
            html.append("    </div>\n");
            html.append("  </div>\n");

            // 空状态
            html.append("  <div class=\"empty-state\" v-else-if=\"data && data.success\">\n");
            html.append("    <h3>暂无历史会话</h3>\n");
            html.append("    <p>当前项目下没有找到 Claude 会话记录</p>\n");
            html.append("  </div>\n");

            // 错误状态
            html.append("  <div v-else class=\"empty-state\">\n");
            html.append("    <h3>⚠️ 加载失败</h3>\n");
            html.append("    <p>{{ error || (data && data.error) || '未知错误' }}</p>\n");
            html.append("  </div>\n");

            html.append("</div>\n");

            html.append("<script>\n");
            html.append("console.log('Starting Vue initialization...');\n");
            html.append("console.log('Vue available:', typeof Vue !== 'undefined');\n");
            html.append("if (typeof Vue === 'undefined') {\n");
            html.append("  console.error('Vue is not loaded!');\n");
            html.append("  document.getElementById('app').innerHTML = '<div style=\"color:red;padding:20px;\">错误：Vue.js 未加载</div>';\n");
            html.append("} else {\n");
            html.append("  const { createApp } = Vue;\n");
            html.append("  const claudeDataStr = '").append(escapedJson).append("';\n");
            html.append("  console.log('Data string length:', claudeDataStr.length);\n");
            html.append("  let claudeData = null;\n");
            html.append("  try {\n");
            html.append("    claudeData = JSON.parse(claudeDataStr);\n");
            html.append("    console.log('Parsed data:', claudeData);\n");
            html.append("  } catch(e) {\n");
            html.append("    console.error('Failed to parse data:', e);\n");
            html.append("    console.error('Data string:', claudeDataStr.substring(0, 200));\n");
            html.append("  }\n");
            html.append("  \n");
            html.append("  const app = createApp({\n");
            html.append("    data() {\n");
            html.append("      return {\n");
            html.append("        data: claudeData,\n");
            html.append("        error: claudeData ? null : 'Failed to parse data'\n");
            html.append("      }\n");
            html.append("    },\n");
            html.append("    methods: {\n");
            html.append("      formatTime(timestamp) {\n");
            html.append("        if (!timestamp) return '';\n");
            html.append("        const date = new Date(timestamp);\n");
            html.append("        return date.toLocaleString();\n");
            html.append("      },\n");
            html.append("      timeAgo(timestamp) {\n");
            html.append("        if (!timestamp) return '';\n");
            html.append("        const seconds = Math.floor((new Date() - new Date(timestamp)) / 1000);\n");
            html.append("        let interval = seconds / 31536000;\n");
            html.append("        if (interval > 1) return Math.floor(interval) + ' 年前';\n");
            html.append("        interval = seconds / 2592000;\n");
            html.append("        if (interval > 1) return Math.floor(interval) + ' 个月前';\n");
            html.append("        interval = seconds / 86400;\n");
            html.append("        if (interval > 1) return Math.floor(interval) + ' 天前';\n");
            html.append("        interval = seconds / 3600;\n");
            html.append("        if (interval > 1) return Math.floor(interval) + ' 小时前';\n");
            html.append("        interval = seconds / 60;\n");
            html.append("        if (interval > 1) return Math.floor(interval) + ' 分钟前';\n");
            html.append("        return Math.floor(seconds) + ' 秒前';\n");
            html.append("      },\n");
            html.append("      loadSession(sessionId) {\n");
            html.append("        console.log('Loading session:', sessionId);\n");
            html.append("        if (window.sendToJava) {\n");
            html.append("          window.sendToJava('load_session:' + sessionId);\n");
            html.append("        } else {\n");
            html.append("          console.error('sendToJava not available');\n");
            html.append("        }\n");
            html.append("      }\n");
            html.append("    },\n");
            html.append("    mounted() {\n");
            html.append("      console.log('Vue app mounted, data:', this.data);\n");
            html.append("    }\n");
            html.append("  });\n");
            html.append("  \n");
            html.append("  app.mount('#app');\n");
            html.append("  console.log('Vue app mounted successfully');\n");
            html.append("}\n");
            html.append("</script>\n");
            html.append("</body>\n");
            html.append("</html>");

            return html.toString();
        }

        public JPanel getContent() {
            return mainPanel;
        }
    }
}