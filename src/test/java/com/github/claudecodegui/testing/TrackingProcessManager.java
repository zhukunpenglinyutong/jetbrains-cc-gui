package com.github.claudecodegui.testing;

import com.github.claudecodegui.bridge.ProcessManager;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Test-only {@link ProcessManager} subclass that records every
 * {@code registerProcess} / {@code unregisterProcess} call so process
 * lifecycle assertions can be written against the recorded state.
 *
 * <p>Extracted from four near-identical inline copies in the
 * {@code *ProcessLifecycleTest} / {@code PromptEnhancerProcessRunnerTest}
 * files. Every test that needs to verify register-before-IO and
 * unregister-in-finally invariants should depend on this class.
 *
 * <p>Counters are {@link AtomicInteger}s and reference holders are
 * {@link AtomicReference}s so they are safely visible from the thread that
 * owns the {@code Process} object as well as the test assertion thread.
 */
public class TrackingProcessManager extends ProcessManager {

    public final AtomicInteger registerCalls = new AtomicInteger();
    public final AtomicInteger unregisterCalls = new AtomicInteger();
    public final AtomicReference<String> lastRegisteredChannelId = new AtomicReference<>();
    public final AtomicReference<String> lastUnregisteredChannelId = new AtomicReference<>();
    public final AtomicReference<Process> registeredProcess = new AtomicReference<>();
    public final AtomicReference<Process> unregisteredProcess = new AtomicReference<>();

    @Override
    public void registerProcess(String channelId, Process process) {
        registerCalls.incrementAndGet();
        lastRegisteredChannelId.set(channelId);
        registeredProcess.set(process);
        super.registerProcess(channelId, process);
    }

    @Override
    public void unregisterProcess(String channelId, Process process) {
        unregisterCalls.incrementAndGet();
        lastUnregisteredChannelId.set(channelId);
        unregisteredProcess.set(process);
        super.unregisterProcess(channelId, process);
    }
}
