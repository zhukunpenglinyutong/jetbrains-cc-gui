package com.github.claudecodegui.session;

import com.github.claudecodegui.CodexSDKBridge;
import com.github.claudecodegui.ClaudeSession.Message;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Codex消息回调处理器
 * 英文：Codex Message Callback Handler
 *
 * 解释：这个类专门负责处理Codex AI返回的消息
 * - 和ClaudeMessageHandler类似，但Codex的消息格式更简单
 * - 主要处理流式文本输出
 */
public class CodexMessageHandler implements CodexSDKBridge.MessageCallback {
    private static final Logger LOG = Logger.getInstance(CodexMessageHandler.class);

    private final SessionState state;
    private final CallbackHandler callbackHandler;

    // 当前助手消息的内容累积器
    // 英文：Current assistant message content accumulator
    // 解释：收集AI说的话
    private final StringBuilder assistantContent = new StringBuilder();

    // 当前助手消息对象
    // 英文：Current assistant message object
    // 解释：正在处理的消息
    private Message currentAssistantMessage = null;

    /**
     * 构造函数
     * 英文：Constructor
     * 解释：创建这个处理器
     */
    public CodexMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        this.state = state;
        this.callbackHandler = callbackHandler;
    }

    /**
     * 处理收到的消息
     * 英文：Handle received message
     * 解释：Codex发来消息时的处理
     */
    @Override
    public void onMessage(String type, String content) {
        // Codex 的简化处理（主要是 content_delta）
        // 英文：Simplified handling for Codex (mainly content_delta)
        // 解释：Codex比较简单，主要就是一字一字输出内容
        if ("content_delta".equals(type)) {
            handleContentDelta(content);
        } else if ("message_end".equals(type)) {
            handleMessageEnd();
        }
    }

    /**
     * 处理错误
     * 英文：Handle error
     * 解释：出错了怎么办
     */
    @Override
    public void onError(String error) {
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    /**
     * 处理完成
     * 英文：Handle completion
     * 解释：Codex说完了
     */
    @Override
    public void onComplete(CodexSDKBridge.SDKResult result) {
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    // ===== 私有方法 =====
    // Private Methods
    // 解释：具体处理消息的小帮手

    /**
     * 处理内容增量（流式输出）
     * 英文：Handle content delta (streaming output)
     * 解释：Codex一字一字地说话
     */
    private void handleContentDelta(String content) {
        assistantContent.append(content);

        if (currentAssistantMessage == null) {
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
            state.addMessage(currentAssistantMessage);
        } else {
            currentAssistantMessage.content = assistantContent.toString();
        }

        callbackHandler.notifyMessageUpdate(state.getMessages());
    }

    /**
     * 处理消息结束
     * 英文：Handle message end
     * 解释：Codex说完这条消息了
     */
    private void handleMessageEnd() {
        state.setBusy(false);
        state.setLoading(false);
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        LOG.debug("Codex message end received");
    }
}
