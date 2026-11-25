package com.github.claudecodegui.ui;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

/** Tests that startup reports distinguish native peers, main-frame loading and bridge submission. */
public class WebviewStartupProgressTest {
    /** Reloading starts a fresh page report without forgetting the existing native peer. */
    @Test
    public void reloadResetsPageMilestonesButKeepsNativePeer() {
        WebviewStartupProgress progress = new WebviewStartupProgress();
        progress.beginPageLoad(1);
        progress.nativeBrowserCreated();
        progress.mainFrameStarted();
        progress.mainFrameFinished(200);
        progress.bridgeSubmitted();
        assertTrue(progress.describe().contains("mainFrame=finished(200)"));
        assertTrue(progress.describe().contains("bridgeSubmissions=1"));

        progress.beginPageLoad(2);
        assertTrue(progress.describe().contains("nativeBrowserCreated=true"));
        assertTrue(progress.describe().contains("pageGeneration=2"));
        assertTrue(progress.describe().contains("mainFrame=not_started"));
        assertTrue(progress.describe().contains("bridgeSubmissions=0"));
    }

    /** A queued script alone must not be presented as successful browser or page startup. */
    @Test
    public void bridgeSubmissionDoesNotPretendNativeCreationOrLoadSucceeded() {
        WebviewStartupProgress progress = new WebviewStartupProgress();
        progress.beginPageLoad(1);
        progress.bridgeSubmitted();
        assertTrue(progress.describe().contains("nativeBrowserCreated=false"));
        assertTrue(progress.describe().contains("mainFrame=not_started"));
    }

    /** Load end can follow a failure, so the error remains visible until the page resets. */
    @Test
    public void loadFailureRemainsVisibleAfterLoadEnd() {
        WebviewStartupProgress progress = new WebviewStartupProgress();
        progress.mainFrameStarted();
        progress.mainFrameFailed("ERR_FILE_NOT_FOUND");
        progress.mainFrameFinished(0);
        progress.bridgeSubmitted();
        assertTrue(progress.describe().contains("mainFrame=finished(0)"));
        assertTrue(progress.describe().contains("mainFrameError=ERR_FILE_NOT_FOUND"));
        assertTrue(progress.describe().contains("bridgeSubmissions=1"));

        progress.beginPageLoad(2);
        assertTrue(progress.describe().contains("mainFrameError=none"));
    }
}
