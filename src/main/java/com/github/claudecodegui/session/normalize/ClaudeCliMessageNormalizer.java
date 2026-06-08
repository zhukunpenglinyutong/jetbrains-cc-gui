package com.github.claudecodegui.session.normalize;

import com.github.claudecodegui.provider.common.MessageCallback;

public final class ClaudeCliMessageNormalizer extends ForwardingMessageNormalizer {
    public ClaudeCliMessageNormalizer(MessageCallback delegate) {
        super(delegate);
    }
}
