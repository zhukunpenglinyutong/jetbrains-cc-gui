package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import com.github.claudecodegui.util.PlatformUtils;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/** Coordinates AI process starts with exclusive AI data directory operations. */
public final class AiDataProcessGate {

    private static final AiDataProcessGate INSTANCE = forPlatform(
            PlatformUtils.getPlatformType(), AiDataMigrationCoordinator.defaultCoordinationDirectory());

    private final ReentrantLock lock = new ReentrantLock(true);
    private final Condition stateChanged = lock.newCondition();
    private int activeProcesses;
    private int activeReaders;
    private int waitingProcesses;
    private boolean migrationActive;
    private boolean cancellationRequested;
    private boolean cancellationAllowed;
    private final AiDataMigrationCoordinator migrationCoordinator;

    public AiDataProcessGate() {
        this(null);
    }

    public AiDataProcessGate(AiDataMigrationCoordinator migrationCoordinator) {
        this.migrationCoordinator = migrationCoordinator;
    }

    static AiDataProcessGate forPlatform(PlatformUtils.PlatformType platform, Path coordinationDirectory) {
        return new AiDataProcessGate(platform == PlatformUtils.PlatformType.WINDOWS
                ? new AiDataMigrationCoordinator(coordinationDirectory) : null);
    }

    public static AiDataProcessGate getInstance() {
        return INSTANCE;
    }

    /** Acquires a process permit, cancelling and waiting for an active migration if necessary. */
    public ProcessPermit acquireProcessPermit() throws InterruptedException {
        lock.lockInterruptibly();
        boolean waiting = false;
        AiDataMigrationCoordinator.ProcessLock processLock = null;
        try {
            while (true) {
                if (!migrationActive && migrationCoordinator != null) {
                    try {
                        processLock = migrationCoordinator.tryAcquireProcessLock();
                    } catch (java.io.IOException error) {
                        throw new IllegalStateException("AI_DATA_COORDINATION_UNAVAILABLE", error);
                    }
                }
                if (!migrationActive && (migrationCoordinator == null || processLock != null)) {
                    break;
                }
                if (!waiting) {
                    waiting = true;
                    waitingProcesses++;
                    if (migrationActive && cancellationAllowed) {
                        cancellationRequested = true;
                    }
                }
                if (migrationCoordinator == null) {
                    stateChanged.await();
                } else {
                    stateChanged.await(50L, TimeUnit.MILLISECONDS);
                }
            }
            activeProcesses++;
            return new ProcessPermit(this, processLock);
        } finally {
            if (waiting) {
                waitingProcesses--;
                if (waitingProcesses == 0 && cancellationAllowed) {
                    cancellationRequested = false;
                }
            }
            lock.unlock();
        }
    }

    /** A bounded read never waits for or cancels migration, and uses the same cross-JVM exclusion. */
    public ReadPermit tryAcquireReadPermit() {
        return tryAcquireReadPermit(false);
    }

    /** Admits only maintenance recovery; ordinary reads and processes still honor pending journals. */
    public ReadPermit tryAcquireMaintenancePermit() {
        return tryAcquireReadPermit(true);
    }

    private ReadPermit tryAcquireReadPermit(boolean maintenance) {
        // Serialize the short admission check. Another reader holding this mutex is not a migration.
        lock.lock();
        try {
            if (migrationActive || !maintenance && waitingProcesses > 0) {
                return null;
            }
            AiDataMigrationCoordinator.ProcessLock shared = null;
            if (migrationCoordinator != null) {
                try {
                    shared = maintenance ? migrationCoordinator.tryAcquireMaintenanceReadLock() : migrationCoordinator.tryAcquireProcessLock();
                } catch (java.io.IOException error) {
                    throw new IllegalStateException("AI_DATA_COORDINATION_UNAVAILABLE", error);
                }
                if (shared == null) {
                    return null;
                }
            }
            activeReaders++;
            return new ReadPermit(this, shared);
        } finally {
            lock.unlock();
        }
    }

    /** Attempts to begin an exclusive migration without waiting for active processes or byte snapshots. */
    public MigrationPermit tryAcquireMigrationPermit() {
        lock.lock();
        try {
            if (migrationActive || activeProcesses > 0 || activeReaders > 0 || waitingProcesses > 0) {
                return null;
            }
            migrationActive = true;
            cancellationRequested = false;
            cancellationAllowed = true;
            return new MigrationPermit(this);
        } finally {
            lock.unlock();
        }
    }

    private boolean isCancellationRequested() {
        lock.lock();
        try {
            return cancellationRequested;
        } finally {
            lock.unlock();
        }
    }

    private boolean beginCommit() {
        lock.lock();
        try {
            if (cancellationRequested) {
                return false;
            }
            cancellationAllowed = false;
            return true;
        } finally {
            lock.unlock();
        }
    }

    private void releaseProcessPermit(AiDataMigrationCoordinator.ProcessLock processLock) {
        if (processLock != null) {
            processLock.close();
        }
        lock.lock();
        try {
            activeProcesses--;
            stateChanged.signalAll();
        } finally {
            lock.unlock();
        }
    }

    private void releaseMigrationPermit() {
        lock.lock();
        try {
            migrationActive = false;
            cancellationRequested = false;
            cancellationAllowed = false;
            stateChanged.signalAll();
        } finally {
            lock.unlock();
        }
    }

    public static final class ReadPermit implements AutoCloseable {
        private final AiDataProcessGate owner;
        private final AiDataMigrationCoordinator.ProcessLock shared;
        private final AtomicBoolean closed = new AtomicBoolean();

        private ReadPermit(AiDataProcessGate owner, AiDataMigrationCoordinator.ProcessLock shared) {
            this.owner = owner;
            this.shared = shared;
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                try {
                    if (shared != null) {
                        shared.close();
                    }
                } finally {
                    owner.lock.lock();
                    try {
                        owner.activeReaders--;
                        owner.stateChanged.signalAll();
                    } finally {
                        owner.lock.unlock();
                    }
                }
            }
        }
    }

    public static final class ProcessPermit implements AutoCloseable {
        private final AiDataProcessGate owner;
        private final AiDataMigrationCoordinator.ProcessLock processLock;
        private final AtomicBoolean closed = new AtomicBoolean();

        private ProcessPermit(AiDataProcessGate owner, AiDataMigrationCoordinator.ProcessLock processLock) {
            this.owner = owner;
            this.processLock = processLock;
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                owner.releaseProcessPermit(processLock);
            }
        }
    }

    public static final class MigrationPermit implements AutoCloseable {
        private final AiDataProcessGate owner;
        private final AtomicBoolean closed = new AtomicBoolean();

        private MigrationPermit(AiDataProcessGate owner) {
            this.owner = owner;
        }

        public boolean isCancellationRequested() {
            return owner.isCancellationRequested();
        }

        public boolean beginCommit() {
            return owner.beginCommit();
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                owner.releaseMigrationPermit();
            }
        }
    }
}
