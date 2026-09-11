package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * HTML loader.
 * Handles HTML file loading and local library injection.
 */
public class HtmlLoader {

    private static final Logger LOG = Logger.getInstance(HtmlLoader.class);
    private static final Map<String, String> CHAT_HTML_CACHE = new ConcurrentHashMap<>();
    private static final Object CHAT_HTML_CACHE_LOCK = new Object();
    private final Class<?> resourceClass;

    public HtmlLoader(Class<?> resourceClass) {
        this.resourceClass = resourceClass;
    }

    /**
     * Load the chat interface HTML.
     * @return the HTML content, or fallback HTML if loading fails
     */
    public String loadChatHtml() {
        // Read the theme once: theme and background color are both derived from the same
        // observation, so a mid-read theme switch cannot produce a mixed dark/light injection.
        boolean isDark = ThemeConfigService.getIdeThemeConfig().get("isDark").getAsBoolean();
        String theme = isDark ? "dark" : "light";
        String bgColor = isDark ? ThemeConfigService.DARK_BG_HEX : ThemeConfigService.LIGHT_BG_HEX;
        String cacheKey = resourceClass.getName() + "\n" + theme;
        String cachedHtml = CHAT_HTML_CACHE.get(cacheKey);
        if (cachedHtml != null) {
            return cachedHtml;
        }

        // Several tabs can initialize concurrently. Serialize the one-time 10 MB resource
        // transformation so a burst of tabs does not duplicate the same allocation and I/O.
        synchronized (CHAT_HTML_CACHE_LOCK) {
            cachedHtml = CHAT_HTML_CACHE.get(cacheKey);
            if (cachedHtml != null) {
                return cachedHtml;
            }

            try (InputStream is = resourceClass.getResourceAsStream("/html/claude-chat.html")) {
                if (is != null) {
                    String html = new String(is.readAllBytes(), StandardCharsets.UTF_8);

                    if (html.contains("<!-- LOCAL_LIBRARY_INJECTION_POINT -->")) {
                        html = injectLocalLibraries(html);
                    } else {
                        LOG.info("Detected bundled modern frontend assets; no additional library injection needed");
                    }

                    // Prepare the complete static page once per theme. Per-tab state is added
                    // later, after this shared result is returned.
                    html = injectIdeTheme(html, theme, bgColor);
                    CHAT_HTML_CACHE.put(cacheKey, html);
                    return html;
                }
            } catch (Exception e) {
                LOG.error("Failed to load claude-chat.html: " + e.getMessage(), e);
            }
        }

        return generateFallbackHtml();
    }

    /**
     * Injects theme bootstrap data with one linear pass over the static document.
     *
     * The bundled JavaScript contains HTML examples, so the body lookup uses the last body
     * before the document's closing tag and cannot accidentally modify an embedded string.
     *
     * @param html the static HTML document.
     * @param theme the IDE theme name.
     * @param bgColor the background color to apply.
     * @return the HTML with the initial theme bootstrap.
     */
    static String injectIdeTheme(String html, String theme, String bgColor) {
        int htmlTagEnd = findOpeningTagEnd(html, "<html", 0);
        int headTagEnd = findOpeningTagEnd(html, "<head", htmlTagEnd + 1);
        int htmlClosingTagStart = html.lastIndexOf("</html>");
        int bodyTagEnd = findLastOpeningTagEnd(
                html, "<body", htmlClosingTagStart >= 0 ? htmlClosingTagStart : html.length());

        String styleAttribute = " style=\"background-color:" + bgColor + ";\"";
        String scriptInjection = "\n    <script>window.__INITIAL_IDE_THEME__ = '"
                + theme + "';</script>";
        StringBuilder result = new StringBuilder(html.length() + styleAttribute.length() * 2
                + scriptInjection.length());
        int cursor = 0;

        if (htmlTagEnd >= cursor) {
            result.append(html, cursor, htmlTagEnd);
            result.append(styleAttribute);
            cursor = htmlTagEnd;
        }
        if (headTagEnd >= cursor) {
            result.append(html, cursor, headTagEnd + 1);
            result.append(scriptInjection);
            cursor = headTagEnd + 1;
        }
        if (bodyTagEnd >= cursor) {
            result.append(html, cursor, bodyTagEnd);
            result.append(styleAttribute);
            cursor = bodyTagEnd;
        }
        result.append(html, cursor, html.length());

        LOG.info("Successfully injected IDE theme (inline styles): " + theme + ", background: " + bgColor);
        return result.toString();
    }

    private static int findOpeningTagEnd(String html, String tagPrefix, int fromIndex) {
        int tagStart = html.indexOf(tagPrefix, Math.max(0, fromIndex));
        while (tagStart >= 0) {
            int nameEnd = tagStart + tagPrefix.length();
            if (nameEnd >= html.length()
                    || Character.isWhitespace(html.charAt(nameEnd))
                    || html.charAt(nameEnd) == '>') {
                return html.indexOf('>', nameEnd);
            }
            tagStart = html.indexOf(tagPrefix, nameEnd);
        }
        return -1;
    }

    private static int findLastOpeningTagEnd(String html, String tagPrefix, int beforeIndex) {
        int tagStart = html.lastIndexOf(tagPrefix, Math.max(0, beforeIndex - 1));
        while (tagStart >= 0) {
            int nameEnd = tagStart + tagPrefix.length();
            if (nameEnd >= html.length()
                    || Character.isWhitespace(html.charAt(nameEnd))
                    || html.charAt(nameEnd) == '>') {
                return html.indexOf('>', nameEnd);
            }
            tagStart = html.lastIndexOf(tagPrefix, tagStart - 1);
        }
        return -1;
    }

    /**
     * Injects all page-start state in one rewrite of the large HTML document.
     *
     * Combining the snippets avoids creating three additional full-size strings when a tab
     * starts or a watchdog recreates the browser.
     *
     * The provider/model pair is injected so each tab can prefer the backend-restored values
     * over the shared localStorage snapshot ("model-selection-state") — without it, every tab
     * in a multi-tab setup hydrates from the same key and clobbers the per-tab provider that
     * ClaudeChatWindow.restorePersistedTabSessionState already applied to the session
     * (issue #1353). Null/empty values are injected as empty strings; the frontend treats an
     * empty string as "no backend preference" and falls back to localStorage.
     *
     * @param html the static HTML document.
     * @param provider the restored provider, or {@code null}.
     * @param model the restored model, or {@code null}.
     * @param presetIds locally available DSH preset IDs.
     * @return the HTML with all page-start state injected.
     */
    public String injectInitialPageState(
            String html,
            String provider,
            String model,
            List<String> presetIds
    ) {
        try {
            String safeProvider = escapeForSingleQuotedJs(provider == null ? "" : provider);
            String safeModel = escapeForSingleQuotedJs(model == null ? "" : model);
            StringBuilder presetValues = new StringBuilder("[");
            if (presetIds != null) {
                boolean first = true;
                for (String presetId : presetIds) {
                    if (presetId == null || presetId.isBlank()) {
                        continue;
                    }
                    if (!first) {
                        presetValues.append(',');
                    }
                    presetValues.append('\'')
                            .append(escapeForSingleQuotedJs(presetId.trim()))
                            .append('\'');
                    first = false;
                }
            }
            presetValues.append(']');

            String scriptInjection = "\n    <script>"
                    + "window.__CCG_PAGE_GENERATION__ = undefined;"
                    + "window.__CCGUI_PAGE_CONTEXT_READY__ = false;"
                    + "window.__CCGUI_PAGE_LOAD_KIND__ = undefined;"
                    + "window.__CCGUI_RECOVERY_RELOAD__ = undefined;"
                    + "window.__CCGUI_RECOVERY_STATE_APPLIED__ = false;"
                    + "</script>"
                    + "\n    <script>window.__INITIAL_DSH_PRESETS__ = "
                    + presetValues + ";</script>"
                    + "\n    <script>"
                    + "window.__INITIAL_TAB_PROVIDER__ = '" + safeProvider + "';"
                    + "window.__INITIAL_TAB_MODEL__ = '" + safeModel + "';"
                    + "</script>";
            int headIndex = html.indexOf("<head>");
            if (headIndex != -1) {
                int insertPos = headIndex + "<head>".length();
                return html.substring(0, insertPos) + scriptInjection + html.substring(insertPos);
            }
        } catch (Exception e) {
            LOG.error("Failed to inject initial page state: " + e.getMessage(), e);
        }
        return html;
    }

    private static String escapeForSingleQuotedJs(String value) {
        // Restricted set — provider/model IDs only contain safe chars in
        // practice, but a malicious settings.json provider list could carry
        // arbitrary text. Reject the small set that can break out of the
        // single-quoted literal.
        return value
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("<", "\\u003c")
                .replace(">", "\\u003e")
                .replace("\u2028", "\\u2028")   // Line separator — string-literal break in pre-ES2019 JS engines
                .replace("\u2029", "\\u2029");  // Paragraph separator — same risk
    }

    /**
     * Generate fallback HTML.
     */
    public String generateFallbackHtml() {
        return "<!DOCTYPE html>" +
            "<html>" +
            "<head>" +
            "<meta charset=\"UTF-8\">" +
            "<title>CC GUI（Claude or Codex）</title>" +
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
            "<h1>Failed to load chat interface</h1>" +
            "<p>Please verify that the HTML resource file exists</p>" +
            "</div>" +
            "</body>" +
            "</html>";
    }

    /**
     * Inject local library file contents into the HTML.
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
            injectedLibs.append("\n    <!-- React and related libraries (local versions) -->\n");
            injectedLibs.append("    <script>/* React 18 */\n").append(reactJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* ReactDOM 18 */\n").append(reactDomJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* Babel Standalone */\n").append(babelJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* Marked */\n").append(markedJs).append("\n    </script>\n");
            injectedLibs.append("    <style>/* VS Code Codicons (with embedded font) */\n").append(codiconCss).append("\n    </style>");

            html = html.replace("<!-- LOCAL_LIBRARY_INJECTION_POINT -->", injectedLibs.toString());

            LOG.info("Successfully injected local libraries (React + ReactDOM + Babel + Codicons)");
        } catch (Exception e) {
            LOG.error("Failed to inject local libraries: " + e.getMessage());
        }

        return html;
    }

    /**
     * Load a resource file as a string.
     */
    private String loadResourceAsString(String resourcePath) throws Exception {
        try (InputStream is = resourceClass.getResourceAsStream(resourcePath)) {
            if (is == null) {
                throw new Exception("Resource not found: " + resourcePath);
            }
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /**
     * Load a resource file as a Base64-encoded string.
     */
    private String loadResourceAsBase64(String resourcePath) throws Exception {
        try (InputStream is = resourceClass.getResourceAsStream(resourcePath)) {
            if (is == null) {
                throw new Exception("Resource not found: " + resourcePath);
            }
            return Base64.getEncoder().encodeToString(is.readAllBytes());
        }
    }
}
