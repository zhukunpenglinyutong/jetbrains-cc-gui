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

import javax.swing.*;
import java.awt.*;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 历史会话工具窗口工厂类（完整版，包含 JavaScript 桥接）
 */
public class CCGuiToolWindowFactory implements ToolWindowFactory {

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        // 创建工具窗口内容
        CCGuiToolWindow ccGuiToolWindow = new CCGuiToolWindow();
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(
                ccGuiToolWindow.getContent(),
                "历史会话",
                false
        );
        toolWindow.getContentManager().addContent(content);
    }

    /**
     * 历史会话工具窗口内容类
     */
    private static class CCGuiToolWindow {
        private JPanel mainPanel;

        public CCGuiToolWindow() {
            createUIComponents();
        }

        private void createUIComponents() {
            mainPanel = new JPanel(new BorderLayout());

            try {
                // 使用 JCEF (Java Chromium Embedded Framework) 显示 HTML 内容
                JBCefBrowser browser = new JBCefBrowser();

                // 读取 HTML 文件内容
                String htmlContent = loadHtmlContent();

                // 加载 HTML 内容
                browser.loadHTML(htmlContent);

                // 添加浏览器组件到面板
                mainPanel.add(browser.getComponent(), BorderLayout.CENTER);

                // 可选：添加 Java-JavaScript 交互桥接
                setupJavaScriptBridge(browser);

            } catch (Exception e) {
                // 如果 JCEF 不可用，显示备用内容
                JLabel label = new JLabel("历史会话", SwingConstants.CENTER);
                label.setFont(new Font("Microsoft YaHei", Font.BOLD, 24));
                mainPanel.add(label, BorderLayout.CENTER);

                // 显示错误信息
                JTextArea errorArea = new JTextArea("注意：JCEF 组件未能加载\n" + e.getMessage());
                errorArea.setEditable(false);
                JScrollPane scrollPane = new JScrollPane(errorArea);
                scrollPane.setPreferredSize(new Dimension(400, 100));
                mainPanel.add(scrollPane, BorderLayout.SOUTH);
            }
        }

        /**
         * 加载 HTML 内容
         */
        private String loadHtmlContent() {
            try {
                // 从资源文件中读取 HTML
                InputStream inputStream = getClass().getClassLoader()
                        .getResourceAsStream("html/index.html");

                if (inputStream != null) {
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
                        return reader.lines().collect(Collectors.joining("\n"));
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }

            // 如果无法加载文件，返回默认 HTML
            return getDefaultHtml();
        }

        /**
         * 获取默认的 HTML 内容
         */
        private String getDefaultHtml() {
            return """
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        }
                        #app {
                            text-align: center;
                            color: white;
                        }
                        h1 {
                            font-size: 48px;
                            margin-bottom: 20px;
                        }
                        .button {
                            padding: 10px 20px;
                            font-size: 16px;
                            background: white;
                            color: #764ba2;
                            border: none;
                            border-radius: 20px;
                            cursor: pointer;
                        }
                    </style>
                </head>
                <body>
                    <div id="app">
                        <h1>{{ message }}</h1>
                        <button class="button" @click="count++">
                            点击次数: {{ count }}
                        </button>
                    </div>
                    <script>
                        const { createApp } = Vue;
                        createApp({
                            data() {
                                return {
                                    message: '历史会话',
                                    count: 0
                                }
                            }
                        }).mount('#app');
                    </script>
                </body>
                </html>
                """;
        }

        /**
         * 设置 JavaScript 桥接
         * 允许 JavaScript 与 Java 代码交互
         */
        private void setupJavaScriptBridge(JBCefBrowser browser) {
            // 创建 Claude 历史记录读取器
            ClaudeHistoryReader historyReader = new ClaudeHistoryReader();

            // 创建 JS 查询对象
            JBCefJSQuery jsQuery = JBCefJSQuery.create(browser);

            // 注册回调处理器
            jsQuery.addHandler((request) -> {
                try {
                    // 解析请求
                    String[] parts = request.split("\\|", 2);
                    String endpoint = parts[0];
                    Map<String, String> params = new HashMap<>();

                    if (parts.length > 1) {
                        // 解析参数
                        String[] paramPairs = parts[1].split("&");
                        for (String pair : paramPairs) {
                            String[] keyValue = pair.split("=", 2);
                            if (keyValue.length == 2) {
                                params.put(keyValue[0], keyValue[1]);
                            }
                        }
                    }

                    // 调用历史记录读取器处理请求
                    String response = historyReader.handleApiRequest(endpoint, params);
                    return new JBCefJSQuery.Response(response);
                } catch (Exception e) {
                    return new JBCefJSQuery.Response(null, 0, e.getMessage());
                }
            });

            // 页面加载完成后注入JavaScript代码
            browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                @Override
                public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                    // 注入全局 API 对象
                    String jsCode = jsQuery.inject("request",
                        "function(response) {" +
                        "  return response;" +
                        "}",
                        "function(error_code, error_msg) {" +
                        "  console.error('Error:', error_code, error_msg);" +
                        "  return null;" +
                        "}"
                    );

                    String injection =
                        "window.ClaudeAPI = {" +
                        "  fetchHistory: function(callback) {" +
                        "    " + jsCode + "('/history', function(response) {" +
                        "      try { callback(JSON.parse(response)); } catch(e) { console.error(e); }" +
                        "    });" +
                        "  }," +
                        "  fetchStats: function(callback) {" +
                        "    " + jsCode + "('/stats', function(response) {" +
                        "      try { callback(JSON.parse(response)); } catch(e) { console.error(e); }" +
                        "    });" +
                        "  }," +
                        "  search: function(query, callback) {" +
                        "    " + jsCode + "('/search|q=' + encodeURIComponent(query), function(response) {" +
                        "      try { callback(JSON.parse(response)); } catch(e) { console.error(e); }" +
                        "    });" +
                        "  }," +
                        "  fetchProject: function(path, callback) {" +
                        "    " + jsCode + "('/project|path=' + encodeURIComponent(path), function(response) {" +
                        "      try { callback(JSON.parse(response)); } catch(e) { console.error(e); }" +
                        "    });" +
                        "  }" +
                        "};" +
                        "console.log('ClaudeAPI injected successfully');";

                    cefBrowser.executeJavaScript(injection, "", 0);
                }
            }, browser.getCefBrowser());
        }

        public JPanel getContent() {
            return mainPanel;
        }
    }
}