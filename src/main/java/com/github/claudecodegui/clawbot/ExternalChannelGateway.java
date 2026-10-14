package com.github.claudecodegui.clawbot;

import java.util.List;

/** Transport-neutral boundary for publishing sanitized session state externally. */
public interface ExternalChannelGateway extends AutoCloseable {

    void publishSessions(List<ClawBotSessionSnapshot> sessions);

    List<ClawBotSessionSnapshot> sessions();

    @Override
    void close();
}
