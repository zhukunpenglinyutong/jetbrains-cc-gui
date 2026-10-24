package com.github.claudecodegui.provider.common;

import java.util.ArrayList;
import java.util.List;

/**
 * SDK response result.
 * Contains the outcome of an AI provider operation.
 */
public class SDKResult {
    public boolean success;
    /** Cancellation proved by termination of an interrupted process, rather than an error-message inference. */
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
