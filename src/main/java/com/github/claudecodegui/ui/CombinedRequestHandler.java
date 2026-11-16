package com.github.claudecodegui.ui;

import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefRequestHandler;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.handler.CefResourceRequestHandler;
import org.cef.misc.BoolRef;
import org.cef.network.CefRequest;

import java.util.List;

/**
 * Registers all of a chat browser's request callbacks with JBCefClient as a single handler.
 *
 * <p>When several request handlers are registered for one browser, JBCefClient up to IntelliJ
 * 2024.1 (build 241) keeps only the last handler's answer. IntelliJ 2024.3 and later take the
 * first non-null resource handler and OR the navigation answers. In v0.6.6 the navigation guard
 * was registered after the asset handler. On 2024.1 its null resource answer hid the asset
 * handler, so every chat tab failed with "Failed to fetch". This class applies the 2024.3+ rule
 * on every platform version.</p>
 */
final class CombinedRequestHandler extends CefRequestHandlerAdapter {

    private final List<CefRequestHandler> handlers;

    CombinedRequestHandler(CefRequestHandler... handlers) {
        this.handlers = List.of(handlers);
    }

    @Override
    public boolean onBeforeBrowse(CefBrowser browser, CefFrame frame, CefRequest request,
                                  boolean userGesture, boolean isRedirect) {
        boolean cancel = false;
        for (CefRequestHandler handler : handlers) {
            cancel |= handler.onBeforeBrowse(browser, frame, request, userGesture, isRedirect);
        }
        return cancel;
    }

    @Override
    public boolean onOpenURLFromTab(CefBrowser browser, CefFrame frame, String targetUrl, boolean userGesture) {
        boolean cancel = false;
        for (CefRequestHandler handler : handlers) {
            cancel |= handler.onOpenURLFromTab(browser, frame, targetUrl, userGesture);
        }
        return cancel;
    }

    @Override
    public CefResourceRequestHandler getResourceRequestHandler(CefBrowser browser, CefFrame frame,
                                                               CefRequest request, boolean isNavigation,
                                                               boolean isDownload, String requestInitiator,
                                                               BoolRef disableDefaultHandling) {
        for (CefRequestHandler handler : handlers) {
            CefResourceRequestHandler resourceHandler = handler.getResourceRequestHandler(browser, frame, request,
                    isNavigation, isDownload, requestInitiator, disableDefaultHandling);
            if (resourceHandler != null) {
                return resourceHandler;
            }
        }
        return null;
    }
}
