package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

/**
 * Unit tests for HTML bootstrap snippets that must run before the frontend bundle.
 */
public class HtmlLoaderTest {

    /** Verifies that runtime page state starts unavailable and does not embed a generation. */
    @Test
    public void injectsPendingPageContextBeforeFrontendBundle() {
        HtmlLoader loader = new HtmlLoader(HtmlLoaderTest.class);
        String html = "<html><head><script src=\"main.js\"></script></head><body></body></html>";

        String injected = loader.injectPageContextBootstrap(html);

        int generationIndex = injected.indexOf("window.__CCG_PAGE_GENERATION__ = undefined");
        int bundleIndex = injected.indexOf("main.js");
        assertTrue(generationIndex > 0);
        assertTrue(generationIndex < bundleIndex);
        assertTrue(injected.contains("window.__CCGUI_PAGE_CONTEXT_READY__ = false"));
    }
}
