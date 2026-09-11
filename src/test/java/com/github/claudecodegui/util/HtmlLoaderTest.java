package com.github.claudecodegui.util;

import org.junit.Assume;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for HTML bootstrap snippets that must run before the frontend bundle.
 */
public class HtmlLoaderTest {

    /** Verifies that theme injection ignores HTML examples embedded in the JavaScript bundle. */
    @Test
    public void injectsThemeIntoDocumentRootTags() {
        String html = "<!doctype html><html lang=\"zh-CN\"><head>"
                + "<script>const sample = '<body class=\\\"embedded\\\">';</script>"
                + "</head><body></body></html>";

        String injected = HtmlLoader.injectIdeTheme(html, "dark", "#1e1e1e");

        assertTrue(injected.contains("<html lang=\"zh-CN\" style=\"background-color:#1e1e1e;\">"));
        assertTrue(injected.contains("<body style=\"background-color:#1e1e1e;\"></body>"));
        assertTrue(injected.contains("const sample = '<body class=\\\"embedded\\\">'"));
        assertTrue(injected.contains("window.__INITIAL_IDE_THEME__ = 'dark'"));
    }

    /** Verifies that all page-start variables are added with one ordered head injection. */
    @Test
    public void injectsInitialPageStateBeforeFrontendBundle() {
        HtmlLoader loader = new HtmlLoader(HtmlLoaderTest.class);
        String html = "<html><head><script src=\"main.js\"></script></head><body></body></html>";

        String injected = loader.injectInitialPageState(
                html, "codex", "gpt-5.6-sol", List.of("custom"));

        int contextIndex = injected.indexOf("window.__CCG_PAGE_GENERATION__ = undefined");
        int presetsIndex = injected.indexOf("window.__INITIAL_DSH_PRESETS__ = ['custom']");
        int providerIndex = injected.indexOf("window.__INITIAL_TAB_PROVIDER__ = 'codex'");
        int bundleIndex = injected.indexOf("main.js");
        assertTrue(contextIndex > 0);
        assertTrue(contextIndex < presetsIndex);
        assertTrue(presetsIndex < providerIndex);
        assertTrue(providerIndex < bundleIndex);
        assertTrue(injected.contains("window.__CCGUI_PAGE_CONTEXT_READY__ = false"));
        assertFalse(injected.contains("\\n    <script>"));
    }

    /** Verifies that the bundled single-file page receives styles on its real document roots. */
    @Test
    public void loadsBundledHtmlWithRootThemeInjection() {
        String html = new HtmlLoader(HtmlLoaderTest.class).loadChatHtml();
        // claude-chat.html is a build artifact (gitignored) and absent until the webview is
        // built; loadChatHtml silently falls back to a minimal error page in that case.
        Assume.assumeTrue("bundled webview page has not been built in this workspace",
                html.contains("<div id=\"app\">"));

        int documentEnd = html.lastIndexOf("</html>");
        int htmlStart = html.indexOf("<html");
        int bodyStart = html.lastIndexOf("<body", documentEnd);
        int bodyEnd = html.indexOf('>', bodyStart);

        assertTrue(htmlStart >= 0);
        assertTrue(html.substring(htmlStart, html.indexOf('>', htmlStart))
                .contains("style=\"background-color:"));
        assertTrue(bodyStart >= 0);
        assertTrue(bodyEnd > bodyStart);
        assertTrue(html.substring(bodyStart, bodyEnd).contains("style=\"background-color:"));
    }
}
