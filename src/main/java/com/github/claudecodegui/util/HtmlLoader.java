package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * HTML 加载器
 * 处理 HTML 文件加载和本地库注入
 */
public class HtmlLoader {

    private static final Logger LOG = Logger.getInstance(HtmlLoader.class);
    private final Class<?> resourceClass;

    public HtmlLoader(Class<?> resourceClass) {
        this.resourceClass = resourceClass;
    }

    /**
     * 加载聊天界面 HTML
     * @return HTML 内容，如果加载失败返回备用 HTML
     */
    public String loadChatHtml() {
        try {
            InputStream is = resourceClass.getResourceAsStream("/html/claude-chat.html");
            if (is != null) {
                String html = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                is.close();

                if (html.contains("<!-- LOCAL_LIBRARY_INJECTION_POINT -->")) {
                    html = injectLocalLibraries(html);
                } else {
                    LOG.info("✓ 检测到打包好的现代前端资源，无需额外注入库文件");
                }

                // 注入 IDE 主题到 HTML，避免页面初始化时闪屏
                html = injectIdeTheme(html);

                return html;
            }
        } catch (Exception e) {
            LOG.error("无法加载 claude-chat.html: " + e.getMessage());
        }

        return generateFallbackHtml();
    }

    /**
     * 将 IDE 主题注入到 HTML 中
     *
     * 策略：直接在 HTML 标签上添加内联 style 属性，确保背景色在第一帧渲染时就生效
     * 1. 修改 <html> 标签，添加 style="background-color:..."
     * 2. 修改 <body> 标签，添加 style="background-color:..."
     * 3. 在 <head> 中注入主题变量脚本
     *
     * 内联样式比 CSS 规则解析更快，能在 CEF 第一帧渲染时就显示正确颜色
     */
    private String injectIdeTheme(String html) {
        try {
            boolean isDark = ThemeConfigService.getIdeThemeConfig().get("isDark").getAsBoolean();
            String theme = isDark ? "dark" : "light";
            // 使用统一的颜色值，确保与 Swing 组件背景色一致
            String bgColor = ThemeConfigService.getBackgroundColorHex();

            // 1. 修改 <html> 标签，添加内联样式
            html = html.replaceFirst(
                "<html([^>]*)>",
                "<html$1 style=\"background-color:" + bgColor + ";\">"
            );

            // 2. 修改 <body> 标签，添加内联样式
            html = html.replaceFirst(
                "<body([^>]*)>",
                "<body$1 style=\"background-color:" + bgColor + ";\">"
            );

            // 3. 在 <head> 标签后注入主题变量脚本
            String scriptInjection = "\n    <script>window.__INITIAL_IDE_THEME__ = '" + theme + "';</script>";
            int headIndex = html.indexOf("<head>");
            if (headIndex != -1) {
                int insertPos = headIndex + "<head>".length();
                html = html.substring(0, insertPos) + scriptInjection + html.substring(insertPos);
            }

            LOG.info("✓ 成功注入 IDE 主题（内联样式）: " + theme + ", 背景色: " + bgColor);
        } catch (Exception e) {
            LOG.error("注入 IDE 主题失败: " + e.getMessage(), e);
        }

        return html;
    }

    /**
     * 生成备用 HTML
     */
    public String generateFallbackHtml() {
        return "<!DOCTYPE html>" +
            "<html>" +
            "<head>" +
            "<meta charset=\"UTF-8\">" +
            "<title>Claude Code GUI</title>" +
            "<style>" +
            "body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; " +
            "background: #1e1e1e; color: #fff; display: flex; align-items: center; " +
            "justify-content: center; height: 100vh; margin: 0; }" +
            ".error { text-align: center; padding: 40px; }" +
            "h1 { color: #f85149; }" +
            "</style>" +
            "</head>" +
            "<body>" +
            "<div class=\"error\">" +
            "<h1>无法加载聊天界面</h1>" +
            "<p>请检查 HTML 资源文件是否存在</p>" +
            "</div>" +
            "</body>" +
            "</html>";
    }

    /**
     * 将本地库文件内容注入到 HTML 中
     */
    private String injectLocalLibraries(String html) {
        try {
            String reactJs = loadResourceAsString("/libs/react.production.min.js");
            String reactDomJs = loadResourceAsString("/libs/react-dom.production.min.js");
            String babelJs = loadResourceAsString("/libs/babel.min.js");
            String markedJs = loadResourceAsString("/libs/marked.min.js");
            String codiconCss = loadResourceAsString("/libs/codicon.css");

            String fontBase64 = loadResourceAsBase64("/libs/codicon.ttf");
            codiconCss = codiconCss.replaceAll(
                "url\\(\"\\./codicon\\.ttf\\?[^\"]*\"\\)",
                "url(\"data:font/truetype;base64," + fontBase64 + "\")"
            );

            StringBuilder injectedLibs = new StringBuilder();
            injectedLibs.append("\n    <!-- React 和相关库 (本地版本) -->\n");
            injectedLibs.append("    <script>/* React 18 */\n").append(reactJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* ReactDOM 18 */\n").append(reactDomJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* Babel Standalone */\n").append(babelJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* Marked */\n").append(markedJs).append("\n    </script>\n");
            injectedLibs.append("    <style>/* VS Code Codicons (含内嵌字体) */\n").append(codiconCss).append("\n    </style>");

            html = html.replace("<!-- LOCAL_LIBRARY_INJECTION_POINT -->", injectedLibs.toString());

            LOG.info("✓ 成功注入本地库文件 (React + ReactDOM + Babel + Codicons)");
        } catch (Exception e) {
            LOG.error("✗ 注入本地库文件失败: " + e.getMessage());
        }

        return html;
    }

    /**
     * 加载资源文件为字符串
     */
    private String loadResourceAsString(String resourcePath) throws Exception {
        InputStream is = resourceClass.getResourceAsStream(resourcePath);
        if (is == null) {
            throw new Exception("无法找到资源: " + resourcePath);
        }
        String content = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        is.close();
        return content;
    }

    /**
     * 加载资源文件为 Base64 字符串
     */
    private String loadResourceAsBase64(String resourcePath) throws Exception {
        InputStream is = resourceClass.getResourceAsStream(resourcePath);
        if (is == null) {
            throw new Exception("无法找到资源: " + resourcePath);
        }
        byte[] bytes = is.readAllBytes();
        is.close();
        return Base64.getEncoder().encodeToString(bytes);
    }
}
