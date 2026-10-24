package com.github.claudecodegui.bridge;

import com.intellij.openapi.diagnostic.Logger;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Coordinates DSH host lifetimes with AI data migration. */
public final class DshHostProcessCoordinator {

    private static final Logger LOG = Logger.getInstance(DshHostProcessCoordinator.class);
    private static final DshHostProcessCoordinator INSTANCE = new DshHostProcessCoordinator();
    private static final Pattern DSH_WEB_COMMAND = Pattern.compile(
            "(^|[\\s/\\\\\"'])dsh(?:[.\\-_][a-z0-9]+)*[\"']?\\s+(?:[\"']web[\"']|web)(?:\\s|$)",
            Pattern.CASE_INSENSITIVE);
    private static final long EXTERNAL_SCAN_TIMEOUT_MILLIS = 500L;

    private final Object monitor = new Object();
    private final AiDataProcessGate processGate;
    private final BooleanSupplier externalHostDetector;
    private final Map<Long, AiDataProcessGate.ProcessPermit> ownedHostPermits = new HashMap<>();

    private DshHostProcessCoordinator() {
        this(AiDataProcessGate.getInstance(), DshHostProcessCoordinator::scanExternalHost);
    }

    DshHostProcessCoordinator(AiDataProcessGate processGate, BooleanSupplier externalHostDetector) {
        this.processGate = processGate;
        this.externalHostDetector = externalHostDetector;
    }

    public static DshHostProcessCoordinator getInstance() {
        return INSTANCE;
    }

    /** Acquires a permit for a short-lived DSH bridge command. */
    public AiDataProcessGate.ProcessPermit acquireCommandPermit() throws InterruptedException {
        return processGate.acquireProcessPermit();
    }

    /**
     * Transfers a command permit to a host spawned by that command. The permit
     * remains held until the host exits or is explicitly stopped.
     */
    public void retainOwnedHost(AiDataProcessGate.ProcessPermit permit, long pid) {
        if (permit == null || pid <= 0L) {
            if (permit != null) {
                permit.close();
            }
            return;
        }
        synchronized (monitor) {
            AiDataProcessGate.ProcessPermit previous = ownedHostPermits.put(pid, permit);
            if (previous != null) {
                previous.close();
            }
        }
        startExitMonitor(pid, permit);
    }

    /** Releases only the permit held for the verified stopped host. */
    public void releaseOwnedHost(long pid) {
        synchronized (monitor) {
            AiDataProcessGate.ProcessPermit permit = ownedHostPermits.remove(pid);
            if (permit != null) {
                permit.close();
            }
        }
    }

    /**
     * Returns true when a DSH host may still use the managed homes. This checks
     * the tracked plugin-owned host and performs a best-effort process scan for
     * adopted/external hosts; migration must fail closed in either case.
     */
    public boolean hasRunningHost() {
        synchronized (monitor) {
            Iterator<Map.Entry<Long, AiDataProcessGate.ProcessPermit>> iterator = ownedHostPermits.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<Long, AiDataProcessGate.ProcessPermit> entry = iterator.next();
                if (isAlive(entry.getKey())) {
                    continue;
                }
                iterator.remove();
                entry.getValue().close();
            }
            if (!ownedHostPermits.isEmpty()) {
                return true;
            }
        }
        return externalHostDetector.getAsBoolean();
    }

    private void startExitMonitor(long pid, AiDataProcessGate.ProcessPermit permit) {
        Optional<ProcessHandle> handle = ProcessHandle.of(pid);
        if (handle.isEmpty() || !handle.get().isAlive()) {
            releaseIfTracked(pid, permit);
            return;
        }
        try {
            handle.get().onExit().thenRun(() -> releaseIfTracked(pid, permit));
        } catch (IllegalStateException | UnsupportedOperationException error) {
            Thread monitorThread = new Thread(() -> {
                while (isTracked(pid, permit) && isAlive(pid)) {
                    try {
                        TimeUnit.SECONDS.sleep(1L);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
                releaseIfTracked(pid, permit);
            }, "dsh-host-permit-monitor");
            monitorThread.setDaemon(true);
            monitorThread.start();
        }
    }

    private boolean isTracked(long pid, AiDataProcessGate.ProcessPermit permit) {
        synchronized (monitor) {
            return ownedHostPermits.get(pid) == permit;
        }
    }

    private void releaseIfTracked(long pid, AiDataProcessGate.ProcessPermit permit) {
        synchronized (monitor) {
            if (ownedHostPermits.remove(pid, permit)) {
                permit.close();
            }
        }
    }

    private static boolean scanExternalHost() {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(EXTERNAL_SCAN_TIMEOUT_MILLIS);
        try {
            try (Stream<ProcessHandle> processes = ProcessHandle.allProcesses()) {
                for (java.util.Iterator<ProcessHandle> iterator = processes.iterator(); iterator.hasNext();) {
                    if (System.nanoTime() >= deadline) {
                        LOG.warn("Timed out inspecting DSH processes before migration; failing closed");
                        return true;
                    }
                    ProcessHandle handle = iterator.next();
                    Optional<String> commandLine = handle.info().commandLine();
                    if (commandLine.isPresent() && looksLikeDshWebCommand(commandLine.get())) {
                        return true;
                    }
                }
            }
        } catch (RuntimeException error) {
            LOG.warn("Unable to inspect DSH processes before migration: " + error.getMessage());
            return true;
        }
        return false;
    }

    static boolean looksLikeDshWebCommand(String commandLine) {
        return commandLine != null && DSH_WEB_COMMAND.matcher(commandLine).find();
    }

    private static boolean isAlive(long pid) {
        return pid > 0L && ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
    }
}
