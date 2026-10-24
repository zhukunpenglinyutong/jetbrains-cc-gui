package com.github.claudecodegui.pet.office;

import java.io.IOException;
import java.util.function.LongSupplier;

/** One acknowledged scene and one staged transfer; renderer failure cannot accumulate an outbound roster queue. */
public final class PetOfficeSceneDelivery {
    private static final long DEADLINE_NANOS = 10_000_000_000L;
    private final String page;
    private final LongSupplier nanoTime;
    private long sequence;
    private Pending pending;
    private PetOfficeSceneProtocol.Scene acknowledged;
    private boolean closed;
    private boolean resyncAfterSend;

    public PetOfficeSceneDelivery(String page) {
        this(page, System::nanoTime);
    }

    PetOfficeSceneDelivery(String page, LongSupplier nanoTime) {
        this.page = page;
        this.nanoTime = nanoTime;
    }

    public synchronized boolean canSend() {
        return !closed && (pending == null || pending.sent && nanoTime.getAsLong() - pending.startedAt >= DEADLINE_NANOS);
    }

    public synchronized PetOfficeSceneProtocol.Transfer prepare(PetOfficeSceneProtocol.Scene scene) throws IOException {
        if (!canSend()) {
            return null;
        }
        PetOfficeSceneProtocol.Transfer transfer = PetOfficeSceneProtocol.scene(page, ++sequence, scene);
        pending = new Pending(transfer, scene, nanoTime.getAsLong(), false);
        return transfer;
    }

    public synchronized void markSent(PetOfficeSceneProtocol.Transfer transfer) {
        if (isCurrent(transfer)) {
            pending = resyncAfterSend ? null : new Pending(transfer, pending.scene, nanoTime.getAsLong(), true);
            resyncAfterSend = false;
        }
    }

    public synchronized boolean acceptAck(String id, long ackSequence) {
        if (closed || pending == null || !pending.transfer.id().equals(id) || pending.transfer.sequence() != ackSequence
                || pending.sent && nanoTime.getAsLong() - pending.startedAt >= DEADLINE_NANOS) {
            return false;
        }
        acknowledged = pending.scene;
        pending = null;
        resyncAfterSend = false;
        return true;
    }

    public synchronized boolean isCurrent(PetOfficeSceneProtocol.Transfer transfer) {
        return !closed && pending != null && pending.transfer == transfer;
    }

    public synchronized PetOfficeAppearanceService.Appearance appearance(String sourceKey, String revision, String digest) {
        if (closed || acknowledged == null) {
            return null;
        }
        PetOfficeAppearanceService.Appearance value = acknowledged.appearances().get(sourceKey);
        return value != null && value.revision().equals(revision) && value.manifest().digest().equals(digest)
                && !digest.isEmpty() ? value : null;
    }

    public synchronized void requestResync() {
        if (pending == null || pending.sent) {
            pending = null;
        } else {
            resyncAfterSend = true;
        }
    }

    public synchronized void close() {
        closed = true;
        pending = null;
        acknowledged = null;
    }

    private record Pending(PetOfficeSceneProtocol.Transfer transfer, PetOfficeSceneProtocol.Scene scene, long startedAt, boolean sent) { }
}
