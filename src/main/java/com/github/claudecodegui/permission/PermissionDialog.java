package com.github.claudecodegui.permission;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefJSQuery;
import com.google.gson.Gson;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandler;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/**
 * 权限请求对话框
 */
public class PermissionDialog extends DialogWrapper {
    private final JBCefBrowser browser;
    private final JBCefJSQuery jsQuery;
    private final PermissionRequest request;
    private Consumer<PermissionDecision> decisionCallback;
    private final Gson gson = new Gson();

    public static class PermissionDecision {
        public final String channelId;
        public final boolean allow;
        public final boolean remember;
        public final String rejectMessage;

        public PermissionDecision(String channelId, boolean allow, boolean remember, String rejectMessage) {
            this.channelId = channelId;
            this.allow = allow;
            this.remember = remember;
            this.rejectMessage = rejectMessage;
        }
    }

    public PermissionDialog(@Nullable Project project, PermissionRequest request) {
        super(project, false);
        this.request = request;

        setTitle("权限请求");
        setModal(true);
        setResizable(false);

        // 创建 JCEF 浏览器
        this.browser = new JBCefBrowser();
        this.jsQuery = JBCefJSQuery.create(browser);

        // 设置 JavaScript 回调
        jsQuery.addHandler((message) -> {
            if (message.startsWith("permission_decision:")) {
                String jsonData = message.substring("permission_decision:".length());
                PermissionDecision decision = gson.fromJson(jsonData, PermissionDecision.class);
                if (decisionCallback != null) {
                    decisionCallback.accept(decision);
                }
                SwingUtilities.invokeLater(() -> close(0));
                return null;
            }
            return null;
        });

        // 加载 HTML
        loadHtml();

        init();
    }

    private void loadHtml() {
        try {
            // 读取 HTML 文件
            InputStream is = getClass().getResourceAsStream("/html/permission-dialog.html");
            if (is == null) {
                throw new RuntimeException("无法找到权限对话框 HTML 文件");
            }

            String html = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))
                    .lines()
                    .collect(Collectors.joining("\n"));

            // 注入 JavaScript 桥接代码
            String jsInjection = String.format(
                    "<script>window.sendToJava = function(message) { %s };</script>",
                    jsQuery.inject("message")
            );
            html = html.replace("</body>", jsInjection + "</body>");

            // 加载 HTML
            browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                @Override
                public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                    // 页面加载完成后，初始化权限请求数据
                    initializeRequestData();
                }
            }, browser.getCefBrowser());

            browser.loadHTML(html);

        } catch (Exception e) {
            e.printStackTrace();
            browser.loadHTML("<html><body><h3>加载权限对话框失败</h3></body></html>");
        }
    }

    private void initializeRequestData() {
        Map<String, Object> requestData = new HashMap<>();
        requestData.put("channelId", request.getChannelId());
        requestData.put("toolName", translateToolName(request.getToolName()));
        requestData.put("inputs", request.getInputs());
        requestData.put("suggestions", request.getSuggestions());

        String json = gson.toJson(requestData);
        String script = String.format("if (window.initPermissionRequest) { window.initPermissionRequest(%s); }", json);

        browser.getCefBrowser().executeJavaScript(script, browser.getCefBrowser().getURL(), 0);
    }

    /**
     * 翻译工具名称为中文
     */
    private String translateToolName(String toolName) {
        Map<String, String> translations = new HashMap<>();
        translations.put("Write", "写入文件");
        translations.put("Edit", "编辑文件");
        translations.put("Delete", "删除文件");
        translations.put("CreateDirectory", "创建目录");
        translations.put("MoveFile", "移动文件");
        translations.put("CopyFile", "复制文件");
        translations.put("ExecuteCommand", "执行命令");
        translations.put("Bash", "执行Shell命令");
        translations.put("RunCode", "运行代码");
        translations.put("InstallPackage", "安装软件包");

        return translations.getOrDefault(toolName, toolName);
    }

    public void setDecisionCallback(Consumer<PermissionDecision> callback) {
        this.decisionCallback = callback;
    }

    @Override
    protected @Nullable JComponent createCenterPanel() {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setPreferredSize(new Dimension(520, 400));
        panel.add(browser.getComponent(), BorderLayout.CENTER);
        return panel;
    }

    @Override
    protected Action[] createActions() {
        // 不显示默认的 OK 和 Cancel 按钮
        return new Action[0];
    }

    @Override
    public void dispose() {
        jsQuery.dispose();
        browser.dispose();
        super.dispose();
    }
}