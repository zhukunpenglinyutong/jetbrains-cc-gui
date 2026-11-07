package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import static org.junit.Assert.*;

public class WebviewRecoveryRequestTest {
    @Test
    public void onlyOneVerifiedAcknowledgementCanRecreateItsOwningPage() {
        WebviewRecoveryRequest request = new WebviewRecoveryRequest();
        Object browser = new Object();
        assertTrue(request.begin("first", browser, 2, 100L));
        assertFalse(request.begin("duplicate-click", browser, 2, 101L));
        assertFalse(request.accept("other-tab", browser, 2, 102L));
        assertTrue(request.isPending());
        assertTrue(request.accept("first", browser, 2, 103L));
        assertFalse(request.accept("first", browser, 2, 104L));
        assertFalse(request.isPending());
    }

    @Test
    public void replacingTheBrowserOrNavigatingInvalidatesTheOldAcknowledgement() {
        for (boolean replaceBrowser : new boolean[]{true, false}) {
            WebviewRecoveryRequest request = new WebviewRecoveryRequest();
            Object browser = new Object();
            request.begin("request", browser, 1, 0L);
            assertFalse(request.accept("request", replaceBrowser ? new Object() : browser,
                    replaceBrowser ? 1 : 2, 100L));
            assertFalse(request.isPending());
        }
    }

    @Test
    public void aLateStorageAcknowledgementCannotDestroyTheView() {
        WebviewRecoveryRequest request = new WebviewRecoveryRequest();
        Object browser = new Object();
        request.begin("late", browser, 1, 100L);
        assertFalse(request.accept("late", browser, 1, 100L + WebviewRecoveryRequest.TIMEOUT_MS));
    }

    @Test
    public void anOldTimeoutCannotCancelANewerRecovery() {
        WebviewRecoveryRequest request = new WebviewRecoveryRequest();
        Object browser = new Object();
        request.begin("first", browser, 1, 0L);
        assertTrue(request.begin("next", browser, 1, WebviewRecoveryRequest.TIMEOUT_MS));
        assertFalse(request.expire("first", WebviewRecoveryRequest.TIMEOUT_MS + 1L));
        assertTrue(request.accept("next", browser, 1, WebviewRecoveryRequest.TIMEOUT_MS + 2L));
    }

    @Test
    public void timeoutAndDisposalReleaseThePendingAttempt() {
        WebviewRecoveryRequest request = new WebviewRecoveryRequest();
        Object browser = new Object();
        request.begin("timeout", browser, 1, 0L);
        assertFalse(request.expire("timeout", 4999L));
        assertTrue(request.expire("timeout", 5000L));
        assertFalse(request.isPending());
        request.begin("disposed", browser, 1, 6000L);
        request.cancel();
        assertFalse(request.accept("disposed", browser, 1, 6001L));
    }
}
