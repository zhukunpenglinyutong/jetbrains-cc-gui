package com.github.claudecodegui.session.normalize;

import com.github.claudecodegui.provider.common.MessageCallback;

public final class ClaudeSdkMessageNormalizer extends ForwardingMessageNormalizer {
    public ClaudeSdkMessageNormalizer(MessageCallback delegate) {
        super(delegate);
    }
}
