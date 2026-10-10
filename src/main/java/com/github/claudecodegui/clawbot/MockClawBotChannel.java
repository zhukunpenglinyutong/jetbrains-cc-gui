package com.github.claudecodegui.clawbot;

import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;

/** In-memory channel used until the external adapter contract is frozen. */
public final class MockClawBotChannel implements ExternalChannelGateway {

    private final AtomicLong revision = new AtomicLong();
    private volatile List<ClawBotSessionSnapshot> sessions = List.of();
    private volatile boolean closed;

    @Override
    public void publishSessions(List<ClawBotSessionSnapshot> values) {
        Objects.requireNonNull(values, "sessions");
        if (closed) {
            return;
        }
        sessions = List.copyOf(values);
        revision.incrementAndGet();
    }

    @Override
    public List<ClawBotSessionSnapshot> sessions() {
        return sessions;
    }

    public long revision() {
        return revision.get();
    }

    @Override
    public void close() {
        closed = true;
        sessions = List.of();
    }
}
