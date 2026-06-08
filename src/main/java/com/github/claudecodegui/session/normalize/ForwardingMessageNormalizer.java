package com.github.claudecodegui.session.normalize;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;

abstract class ForwardingMessageNormalizer implements MessageCallback {
    protected final MessageCallback delegate;

    ForwardingMessageNormalizer(MessageCallback delegate) {
        this.delegate = delegate;
    }

    @Override
    public void onMessage(String type, String content) {
        delegate.onMessage(type, content);
    }

    @Override
    public void onError(String error) {
        delegate.onError(error);
    }

    @Override
    public void onComplete(SDKResult result) {
        delegate.onComplete(result);
    }

    @Override
    public void onQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState state, int aheadCount) {
        delegate.onQueueDisplayStateChanged(state, aheadCount);
    }
}
