package com.github.claudecodegui.ui;

import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefClient;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLifeSpanHandlerAdapter;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.network.CefRequest;

import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Keeps the chat webview on its own page.
 *
 * <p>Message links are normally routed to the system browser by the frontend's
 * {@code open_browser} bridge. A user-initiated navigation the frontend does not intercept
 * (for example a click on a linked image, or a link opened as a popup) would otherwise load
 * the site inside the tool window, replacing the chat with no way back except closing the tab.
 * This guard cancels such navigations and popups and opens web URLs in the system browser.</p>
 */
final class ExternalNavigationGuard {

    private static final Logger LOG = Logger.getInstance(ExternalNavigationGuard.class);

    /** Same scheme allowlist as {@code OpenFileHandler.isSafeExternalUrl}. */
    private static final Pattern EXTERNAL_URL_PATTERN =
            Pattern.compile("^(https?|mailto):.*$", Pattern.CASE_INSENSITIVE);

    private final Consumer<String> externalOpener;

    ExternalNavigationGuard(Consumer<String> externalOpener) {
        this.externalOpener = externalOpener;
    }

    /** Registers the guard on the browser's own client. */
    static void install(JBCefBrowser browser) {
        ExternalNavigationGuard guard = new ExternalNavigationGuard(ExternalNavigationGuard::openInSystemBrowser);
        JBCefClient client = browser.getJBCefClient();
        CefBrowser cefBrowser = browser.getCefBrowser();
        client.addRequestHandler(new CefRequestHandlerAdapter() {
            @Override
            public boolean onBeforeBrowse(CefBrowser target, CefFrame frame, CefRequest request,
                                          boolean userGesture, boolean isRedirect) {
                return guard.handleNavigation(request.getURL(), userGesture);
            }
        }, cefBrowser);
        client.addLifeSpanHandler(new CefLifeSpanHandlerAdapter() {
            @Override
            public boolean onBeforePopup(CefBrowser target, CefFrame frame, String targetUrl,
                                         String targetFrameName) {
                return guard.handlePopup(targetUrl);
            }
        }, cefBrowser);
    }

    /**
     * Returns true to cancel the navigation. The plugin's own loads ({@code loadHTML}, watchdog
     * and error-boundary reloads) target {@code file:///jbcefbrowser/}, so they are never cancelled.
     */
    boolean handleNavigation(String url, boolean userGesture) {
        if (!userGesture || !isExternalUrl(url)) {
            return false;
        }
        externalOpener.accept(url);
        return true;
    }

    /** Returns true to cancel the popup: a popup window from the tool window is never wanted. */
    boolean handlePopup(String url) {
        if (isExternalUrl(url)) {
            externalOpener.accept(url);
        } else {
            LOG.debug("Blocked webview popup with a non-web URL");
        }
        return true;
    }

    private static boolean isExternalUrl(String url) {
        return url != null && EXTERNAL_URL_PATTERN.matcher(url).matches();
    }

    private static void openInSystemBrowser(String url) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                BrowserUtil.browse(url);
            } catch (Exception e) {
                LOG.warn("Cannot open link in the system browser: " + e.getMessage(), e);
            }
        });
    }
}
