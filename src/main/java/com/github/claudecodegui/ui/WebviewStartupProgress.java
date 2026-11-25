package com.github.claudecodegui.ui;

/** Keeps browser creation, page loading and bridge submission distinct during startup recovery. */
final class WebviewStartupProgress {
    private boolean nativeBrowserCreated;
    private int pageGeneration;
    private String mainFrame = "not_started";
    private String mainFrameError = "none";
    private int bridgeSubmissions;

    synchronized void nativeBrowserCreated() {
        this.nativeBrowserCreated = true;
    }

    synchronized void beginPageLoad(int generation) {
        this.pageGeneration = generation;
        this.mainFrame = "not_started";
        this.mainFrameError = "none";
        this.bridgeSubmissions = 0;
    }

    synchronized void mainFrameStarted() {
        this.mainFrame = "loading";
    }

    synchronized void mainFrameFinished(int httpStatus) {
        this.mainFrame = "finished(" + httpStatus + ")";
    }

    synchronized void mainFrameFailed(String errorCode) {
        this.mainFrame = "failed";
        // CEF can also deliver onLoadEnd for a navigation that failed after commit.
        this.mainFrameError = errorCode;
    }

    synchronized void bridgeSubmitted() {
        // executeJavaScript returning does not prove that the renderer executed the bootstrap.
        this.bridgeSubmissions++;
    }

    synchronized String describe() {
        return "nativeBrowserCreated=" + this.nativeBrowserCreated
                + ", pageGeneration=" + this.pageGeneration
                + ", mainFrame=" + this.mainFrame
                + ", mainFrameError=" + this.mainFrameError
                + ", bridgeSubmissions=" + this.bridgeSubmissions;
    }
}
