package com.github.claudecodegui.session.normalize;

import com.github.claudecodegui.provider.common.MessageCallback;

public final class CodexSdkMessageNormalizer extends ForwardingMessageNormalizer {
    public CodexSdkMessageNormalizer(MessageCallback delegate) {
        super(delegate);
    }
}
