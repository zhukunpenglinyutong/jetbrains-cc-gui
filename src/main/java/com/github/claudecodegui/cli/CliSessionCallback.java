package com.github.claudecodegui.cli;

/**
 * CLI 会话事件回调，不依赖 SDK 层。
 * type 值与 MessageCallback 保持一致，便于适配层转换。
 */
public interface CliSessionCallback {
    void onMessage(String type, String content);
    void onError(String error);
    void onComplete(boolean success, String finalResult, String error);

    default void onInterrupted(String finalResult, String message) {
        onComplete(false, finalResult, message);
    }
}
