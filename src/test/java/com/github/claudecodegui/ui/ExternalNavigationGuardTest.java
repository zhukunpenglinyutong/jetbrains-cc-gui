package com.github.claudecodegui.ui;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Tests which webview navigations are moved to the system browser. */
public class ExternalNavigationGuardTest {

    private final List<String> opened = new ArrayList<>();
    private final ExternalNavigationGuard guard = new ExternalNavigationGuard(opened::add);

    @Test
    public void userClickedWebLinkOpensInSystemBrowserInsteadOfReplacingChat() {
        assertTrue(guard.handleNavigation("https://github.com/org/repo/pull/1", true));
        assertTrue(guard.handleNavigation("HTTP://example.com", true));
        assertTrue(guard.handleNavigation("mailto:dev@example.com", true));

        assertEquals(List.of("https://github.com/org/repo/pull/1", "HTTP://example.com",
                "mailto:dev@example.com"), opened);
    }

    @Test
    public void programmaticLoadsAndReloadsStayInWebview() {
        // loadHTML pages live on file:///jbcefbrowser/; the ErrorBoundary reset reloads that URL.
        assertFalse(guard.handleNavigation("file:///jbcefbrowser/1234#url=about:blank", false));
        assertFalse(guard.handleNavigation("file:///jbcefbrowser/1234#url=about:blank", true));
        assertFalse(guard.handleNavigation("https://example.com", false));
        assertFalse(guard.handleNavigation(null, true));

        assertTrue(opened.isEmpty());
    }

    @Test
    public void userClickedNonWebSchemesAreNotHandedToTheOs() {
        assertFalse(guard.handleNavigation("javascript:alert(1)", true));
        assertFalse(guard.handleNavigation("file:///etc/passwd", true));

        assertTrue(opened.isEmpty());
    }

    @Test
    public void popupsNeverOpenInsideTheToolWindow() {
        assertTrue(guard.handlePopup("https://example.com/docs"));
        assertTrue(guard.handlePopup("file:///etc/passwd"));
        assertTrue(guard.handlePopup(null));

        assertEquals(List.of("https://example.com/docs"), opened);
    }
}
