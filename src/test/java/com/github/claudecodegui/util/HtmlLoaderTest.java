package com.github.claudecodegui.util;

import org.junit.Assume;
import org.junit.Test;

import java.util.List;
import java.util.regex.Pattern;

import static org.junit.Assert.assertEquals;
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

    /** Verifies that the draft key joins the single head injection, before the bundle, escaped once. */
    @Test
    public void injectsDraftCacheKeyOnceBeforeFrontendBundle() {
        HtmlLoader loader = new HtmlLoader(HtmlLoaderTest.class);
        String html = "<html><head><script>const sample = '<head></head>';</script>"
                + "<script src=\"main.js\"></script></head><body></body></html>";

        String injected = loader.injectInitialPageState(
                html, "claude", "", List.of(), "hash:window-'</script>");

        String expected = "window.__CCGUI_DRAFT_CACHE_KEY__ = 'hash:window-\\'\\u003c/script\\u003e';";
        int keyIndex = injected.indexOf(expected);
        assertTrue(keyIndex > 0);
        assertEquals(injected.indexOf("__CCGUI_DRAFT_CACHE_KEY__"),
                injected.lastIndexOf("__CCGUI_DRAFT_CACHE_KEY__"));
        assertTrue(keyIndex < injected.indexOf("const sample"));
        assertTrue(injected.contains("const sample = '<head></head>';"));
    }

    /** Verifies that hosts without a draft key keep draft persistence disabled. */
    @Test
    public void omitsDraftCacheKeyWhenHostHasNone() {
        HtmlLoader loader = new HtmlLoader(HtmlLoaderTest.class);
        String html = "<html><head></head><body></body></html>";

        assertFalse(loader.injectInitialPageState(html, null, null, List.of(), null)
                .contains("__CCGUI_DRAFT_CACHE_KEY__"));
        assertFalse(loader.injectInitialPageState(html, null, null, List.of())
                .contains("__CCGUI_DRAFT_CACHE_KEY__"));
    }

    /** Verifies that the bundled page keeps its theme bootstrap and lightweight asset entry. */
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
        assertTrue("per-tab HTML must not inline the frontend bundle", html.length() < 32_768);
        assertTrue(html.contains("https://cc-gui-webview.local/assets/"));
        assertTrue("entry must be fetched as a single compressed canonical asset",
                Pattern.compile("[\"']https://cc-gui-webview\\.local/assets/[^\"'/]+\\.js\\.gz[\"']")
                        .matcher(html).find());
        assertTrue("entry import map must remap the canonical module URL to the evaluated blob",
                Pattern.compile("imports:\\s*\\{\\s*\\[\"https://cc-gui-webview\\.local/assets/[^\"'/]+\\.js\"\\]:\\s*objectUrl")
                        .matcher(html).find());
        assertTrue(html.contains("type = 'importmap'"));
        assertTrue("the verified source must be evaluated exactly once, as a module",
                html.contains("await import(objectUrl)"));
        assertFalse("a direct canonical import would evaluate the entry twice",
                Pattern.compile("import\\(\\s*[\"']https://cc-gui-webview\\.local/assets/")
                        .matcher(html).find());
        assertFalse("a module script tag would load the entry a second time",
                html.contains("<script type=\"module\""));
    }
}
