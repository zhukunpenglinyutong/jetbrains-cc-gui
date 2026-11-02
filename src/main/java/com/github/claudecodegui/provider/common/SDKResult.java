package com.github.claudecodegui.provider.common;

import java.util.ArrayList;
import java.util.List;

/**
 * SDK response result.
 * Contains the outcome of an AI provider operation.
 */
public class SDKResult {
    public boolean success;
    /**
     * Stop outcome reported by the transport, never inferred from error text: an interrupted process
     * exited abnormally, Codex acknowledged a native abort, or {@code DaemonBridge.sendAbort()} detached
     * a daemon request. The daemon case does not wait for the daemon to acknowledge the abort.
     */
    public boolean cancelled;
    /** The owned process has exited; unlike a transport error, this is final lifecycle evidence. */
    public boolean processExited;
    public String error;
    public int messageCount;
    public List<Object> messages;
    public String rawOutput;
    public String finalResult;

    public SDKResult() {
        this.messages = new ArrayList<>();
    }

    /**
     * Create a successful result.
     */
    public static SDKResult success(String finalResult) {
        SDKResult result = new SDKResult();
        result.success = true;
        result.finalResult = finalResult;
        return result;
    }

    /**
     * Create a failed result.
     */
    public static SDKResult error(String errorMessage) {
        SDKResult result = new SDKResult();
        result.success = false;
        result.error = errorMessage;
        return result;
    }
}
