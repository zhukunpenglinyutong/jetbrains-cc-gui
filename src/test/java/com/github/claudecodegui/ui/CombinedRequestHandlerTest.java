package com.github.claudecodegui.ui;

import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.handler.CefResourceRequestHandler;
import org.cef.handler.CefResourceRequestHandlerAdapter;
import org.cef.misc.BoolRef;
import org.cef.network.CefRequest;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/** Tests that the chat browser's request callbacks do not depend on JBCefClient's merge rule. */
public class CombinedRequestHandlerTest {

    private static final CefResourceRequestHandler ASSET = new CefResourceRequestHandlerAdapter() {
    };

    private static CefRequestHandlerAdapter serving(CefResourceRequestHandler result) {
        return new CefRequestHandlerAdapter() {
            @Override
            public CefResourceRequestHandler getResourceRequestHandler(CefBrowser browser, CefFrame frame,
                    CefRequest request, boolean isNavigation, boolean isDownload, String requestInitiator,
                    BoolRef disableDefaultHandling) {
                return result;
            }
        };
    }

    private static CefRequestHandlerAdapter cancelling(boolean cancel) {
        return new CefRequestHandlerAdapter() {
            @Override
            public boolean onBeforeBrowse(CefBrowser browser, CefFrame frame, CefRequest request,
                    boolean userGesture, boolean isRedirect) {
                return cancel;
            }

            @Override
            public boolean onOpenURLFromTab(CefBrowser browser, CefFrame frame, String targetUrl,
                    boolean userGesture) {
                return cancel;
            }
        };
    }

    private static CefResourceRequestHandler resourceFor(CombinedRequestHandler handler) {
        return handler.getResourceRequestHandler(null, null, null, false, false, null, new BoolRef());
    }

    @Test
    public void laterHandlerWithoutResourceDoesNotHideTheAssetHandler() {
        // IntelliJ 2024.1 keeps only the last handler's answer; the navigation guard came last
        // and returned null, so every chat tab failed with "Failed to fetch".
        assertSame(ASSET, resourceFor(new CombinedRequestHandler(serving(null), serving(ASSET), cancelling(true))));
        assertNull(resourceFor(new CombinedRequestHandler(serving(null), cancelling(false))));
    }

    @Test
    public void anyHandlerCanCancelNavigation() {
        CombinedRequestHandler guarded = new CombinedRequestHandler(serving(ASSET), cancelling(true));
        assertTrue(guarded.onBeforeBrowse(null, null, null, true, false));
        assertTrue(guarded.onOpenURLFromTab(null, null, "https://example.com", true));

        CombinedRequestHandler open = new CombinedRequestHandler(serving(ASSET), cancelling(false));
        assertFalse(open.onBeforeBrowse(null, null, null, true, false));
        assertFalse(open.onOpenURLFromTab(null, null, "https://example.com", true));
    }
}
