package com.github.claudecodegui.pet.office;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.awt.GraphicsEnvironment;
import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.BooleanSupplier;

/** One opt-in coordinator and one metadata publisher per GUI IDE. No provider, CLI or ClawBot dependency. */
@Service(Service.Level.APP)
public final class PetOfficeRuntimeService implements Disposable {
    private static final Logger LOG = Logger.getInstance(PetOfficeRuntimeService.class);
    private final ExecutorService worker = AppExecutorUtil.createBoundedApplicationPoolExecutor("Pet Office participant", 1);
    private final AtomicBoolean disposed = new AtomicBoolean();
    private final AtomicBoolean queued = new AtomicBoolean();
    private final AtomicReference<Owner> owner = new AtomicReference<>();
    private ScheduledFuture<?> timer;
    private Path directory;
    private volatile PetOfficeIpcClient client;
    private volatile PetOfficeSessionPublisher publisher;
    private PetOfficeEndpointStore.Endpoint joined;
    private long retryAt;
    private long backoffMillis = 250;
    private String lastError = "";
    private long lastPublication;
    private long nextEndpointCheck;
    private long nextRecovery;
    private PetOfficeAssetChannel assetChannel;
    private PetOfficeModeStore modes;
    private PetOfficeModeStore.Member member;
    private volatile PetOfficeModeStore.Control observedMode;
    private final AtomicBoolean modeUiQueued = new AtomicBoolean();

    private record Owner(PetOfficeRuntimeLease lease, PetOfficeEndpointStore store, PetOfficeIpcServer server,
                         PetOfficeParticipantRegistry registry, String instanceId, PetOfficeRecoveryStore recovery,
                         PetOfficeRemoteAppearances appearances, PetOfficeModeStore.Control entering) { }

    public static PetOfficeRuntimeService getInstance() {
        return ApplicationManager.getApplication().getService(PetOfficeRuntimeService.class);
    }

    public synchronized void start() {
        if (!disposed.get() && timer == null && SystemInfo.isWindows && !GraphicsEnvironment.isHeadless()) {
            timer = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> {
                if (queued.compareAndSet(false, true)) {
                    try {
                        worker.execute(() -> {
                            try {
                                tick();
                            } finally {
                                queued.set(false);
                            }
                        });
                    } catch (RejectedExecutionException stopped) {
                        queued.set(false);
                    }
                }
            }, 250, 250, TimeUnit.MILLISECONDS);
        }
    }

    /** Called on the Office startup worker after eligibility and exclusive lease acquisition. */
    PetOfficeRecoveryStore.Intent startOwner(Path root, PetOfficeRuntimeLease lease, Runnable show,
                                            PetOfficeRecoveryStore.Intent expected, boolean explicit) throws Exception {
        AtomicBoolean cancelled = new AtomicBoolean();
        var pending = worker.submit(() -> {
            if (cancelled.get() || disposed.get() || !lease.isValid() || owner.get() != null) {
                throw new IOException("OFFICE_LEADER_LOST");
            }
            directory = root;
            ensureModeMember();
            PetOfficeSessionPublisher publisher = publisher();
            String instanceId = publisher.snapshot().instanceId();
            var registry = new PetOfficeParticipantRegistry();
            var store = new PetOfficeEndpointStore(root);
            var server = new PetOfficeIpcServer(instanceId, registry, () -> !cancelled.get() && !disposed.get() && lease.isValid(),
                    () -> { if (!cancelled.get() && !disposed.get() && lease.isValid()) { show.run(); } });
            server.onExit(() -> PetOfficePrototypeService.getInstance().exitOwned(lease));
            var recovery = new PetOfficeRecoveryStore(root);
            var appearances = new PetOfficeRemoteAppearances(instanceId, registry, () -> !cancelled.get() && !disposed.get() && lease.isValid() && server.isRunning());
            PetOfficeModeStore.Control entering;
            try {
                entering = modes.beginEnter(server.endpoint().leaderEpoch(), lease);
            } catch (IOException | RuntimeException failure) {
                server.close();
                appearances.close();
                throw failure;
            }
            Owner acquired = new Owner(lease, store, server, registry, instanceId, recovery, appearances, entering);
            boolean successful = false;
            PetOfficeRecoveryStore.Intent intent;
            try {
                store.publish(server.endpoint(), lease);
                disconnectClient();
                client = new PetOfficeIpcClient(server.endpoint(), instanceId);
                joined = server.endpoint();
                publisher.setOfficeActive(true);
                client.publish(publisher.sample());
                client.assetEndpoint(assetChannel().endpoint());
                synchronized (lease) {
                    if (cancelled.get() || disposed.get() || !lease.isValid()) {
                        throw new IOException("OFFICE_LEADER_LOST");
                    }
                    intent = recovery.adopt(server.endpoint().leaderEpoch(), expected, explicit, lease);
                    if (cancelled.get() || disposed.get() || !lease.isValid() || !owner.compareAndSet(null, acquired)) {
                        throw new IOException("OFFICE_LEADER_LOST");
                    }
                    successful = true;
                }
                start();
            } finally {
                if (!successful) {
                    disconnectClient();
                    server.close();
                    appearances.close();
                    store.removeOwned(server.endpoint(), lease);
                }
            }
            return intent;
        });
        try {
            return pending.get(15, TimeUnit.SECONDS);
        } catch (Exception failure) {
            synchronized (lease) {
                cancelled.set(true);
                pending.cancel(false);
            }
            Throwable cause = failure.getCause();
            if (cause instanceof IOException checked) {
                throw checked;
            }
            throw failure;
        }
    }

    /** Enqueue a user visibility request on the existing publishing stream, without blocking the EDT. */
    boolean showExisting(Path root, Consumer<String> completion) {
        try {
            worker.execute(() -> {
                String result = "";
                try {
                    directory = root;
                    if (!connectCurrent()) {
                        throw new IOException("OFFICE_COORDINATOR_UNAVAILABLE");
                    }
                    client.show();
                    start();
                } catch (Exception failure) {
                    result = code(failure);
                    fail(result);
                }
                completion.accept(result);
            });
            return true;
        } catch (RejectedExecutionException stopped) {
            return false;
        }
    }

    /** Safe exit is available to sender-only IDEs too; it never acquires renderer authority. */
    public void exitOffice(Consumer<String> completion) {
        try {
            worker.execute(() -> {
                String result = "";
                try {
                    if (directory == null) {
                        directory = PetOfficeWindowsRuntime.resolveDirectory();
                    }
                    var available = PetOfficeRuntimeLease.tryAcquire(directory);
                    if (available.isPresent()) {
                        try (var administrative = available.get()) {
                            new PetOfficeModeStore(directory).read();
                            new PetOfficeRecoveryStore(directory).disable(administrative);
                            new PetOfficeModeStore(directory).commitOverlay(administrative);
                        }
                    } else {
                        if (!connectCurrent()) {
                            throw new IOException("OFFICE_COORDINATOR_UNAVAILABLE");
                        }
                        client.exitOffice();
                    }
                } catch (Exception failure) {
                    if (failure instanceof InterruptedException) {
                        Thread.currentThread().interrupt();
                    }
                    result = code(failure);
                }
                completion.accept(result);
            });
        } catch (RejectedExecutionException stopped) {
            completion.accept("OFFICE_RUNTIME_CLOSED");
        }
    }

    PetOfficeParticipantRegistry.View view() throws IOException {
        Owner current = owner.get();
        if (current == null || disposed.get() || !current.lease().isValid()) {
            throw new IOException("OFFICE_COORDINATOR_UNAVAILABLE");
        }
        return current.registry().view(current.instanceId(), current.server().endpoint().leaderEpoch());
    }

    boolean owns(PetOfficeRuntimeLease lease) {
        Owner current = owner.get();
        return !disposed.get() && current != null && current.lease() == lease && lease.isValid() && current.server().isRunning();
    }

    java.util.Map<String, PetOfficeAppearanceService.Appearance> appearances(PetOfficeSessionRegistry.CompleteSnapshot snapshot) throws IOException {
        Owner current = owner.get();
        if (current == null || !owns(current.lease())) {
            throw new IOException("OFFICE_LEADER_LOST");
        }
        return current.appearances().view(snapshot);
    }

    byte[] assetBytes(String key, PetOfficeAppearanceService.Appearance appearance, BooleanSupplier pageValid) throws IOException {
        Owner current = owner.get();
        if (current == null || !owns(current.lease())) {
            throw new IOException("OFFICE_LEADER_LOST");
        }
        return current.appearances().bytes(key, appearance, () -> owns(current.lease()) && pageValid.getAsBoolean());
    }

    private PetOfficeAssetChannel assetChannel() throws IOException {
        if (assetChannel == null) {
            PetOfficeSessionPublisher publisher = publisher();
            var assets = new PetOfficeAppearanceService(
                    () -> PetOfficeAssetRoot.resolvePets(Path.of(com.github.claudecodegui.util.PlatformUtils.getHomeDirectory())),
                    () -> com.github.claudecodegui.bridge.AiDataProcessGate.getInstance().tryAcquireReadPermit());
            assetChannel = new PetOfficeAssetChannel(publisher.snapshot().instanceId(),
                    new PetOfficeAppearancePublisher(publisher::snapshot, publisher::visualConfiguration, assets));
        }
        return assetChannel;
    }

    void navigate(String page, PetOfficeTabNavigator.Request request, BooleanSupplier pageValid,
                  Consumer<PetOfficeTabNavigator.Result> completed, long receivedAt) {
        Owner current = owner.get();
        if (current == null || !owns(current.lease())) {
            completed.accept(PetOfficeTabNavigator.Result.UNAVAILABLE);
        } else {
            current.server().routes().submit(page, request, pageValid, completed, receivedAt);
        }
    }

    void closePage(String page) {
        Owner current = owner.get();
        if (current != null) {
            current.server().routes().closePage(page);
        }
    }

    void presentation(PetOfficeRuntimeLease lease, boolean enabled, boolean visible, Consumer<String> completion) {
        try {
            worker.execute(() -> {
                String error = "";
                try {
                    Owner current = owner.get();
                    if (current == null || !owns(lease)) {
                        throw new IOException("OFFICE_LEADER_LOST");
                    }
                    current.recovery().write(current.server().endpoint().leaderEpoch(), enabled, visible, lease);
                    if (!enabled) {
                        modes.beginExit(current.server().endpoint().leaderEpoch(), lease);
                    }
                } catch (Exception failure) {
                    error = code(failure);
                }
                completion.accept(error);
            });
        } catch (RejectedExecutionException stopped) {
            completion.accept("OFFICE_RUNTIME_CLOSED");
        }
    }

    /** Window disposal is acknowledged before this worker-side cleanup; this method never releases the lease. */
    void stopOwner(PetOfficeRuntimeLease lease) {
        Owner current = owner.get();
        if (current != null && current.lease() == lease && owner.compareAndSet(current, null)) {
            current.server().close();
            current.appearances().close();
            try {
                var intent = current.recovery().read();
                if (intent != null && !intent.enabled()) {
                    new PetOfficeModeStore(directory).commitOverlay(lease);
                }
                current.store().removeOwned(current.server().endpoint(), lease);
            } catch (IOException unavailable) {
                LOG.warn("[PetOffice] OFFICE_ENDPOINT_CLEANUP_FAILED");
            }
        }
    }

    private void tick() {
        if (disposed.get()) {
            return;
        }
        try {
            if (directory == null) {
                directory = PetOfficeWindowsRuntime.resolveDirectory();
            }
            ensureModeMember();
            pollMode();
        } catch (Exception unavailable) {
            if (unavailable instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            detachAfterModeFailure();
            lastError = code(unavailable);
            return;
        }
        if (retryAt != 0 && System.nanoTime() - retryAt < 0) {
            return;
        }
        try {
            if (directory == null) {
                directory = PetOfficeWindowsRuntime.resolveDirectory();
            }
            long now = System.nanoTime();
            boolean connected = client != null;
            if (nextEndpointCheck == 0 || now - nextEndpointCheck >= 0) {
                nextEndpointCheck = now + TimeUnit.SECONDS.toNanos(2);
                connected = connectCurrent();
            }
            if (connected) {
                if (lastPublication == 0 || now - lastPublication >= TimeUnit.SECONDS.toNanos(2)) {
                    client.publish(publisher().sample());
                    lastPublication = now;
                }
                PetOfficeIpcClient observed = client;
                long began = System.nanoTime();
                for (var command : observed.poll()) {
                    dispatch(observed, command, began);
                }
                Owner current = owner.get();
                if (current != null) {
                    current.server().routes().expire();
                }
                lastError = "";
                backoffMillis = 250;
                retryAt = 0;
            } else {
                recover();
            }
        } catch (Exception failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            fail(code(failure));
            recover();
        }
    }

    /** Runs on the startup worker, leaving the participant/control worker free to collect EDT acknowledgements. */
    void awaitDisplayReady(PetOfficeRuntimeLease lease) throws Exception {
        Owner current = owner.get();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (owns(lease) && System.nanoTime() - deadline < 0) {
            if (new PetOfficeModeStore(directory).commitOffice(current.entering(), lease)) {
                return;
            }
            Thread.sleep(50);
        }
        throw new IOException("OFFICE_OVERLAY_DETACH_PENDING");
    }

    private void ensureModeMember() throws IOException {
        if (modes == null) {
            modes = new PetOfficeModeStore(directory);
        }
        if (member == null) {
            ProcessHandle process = ProcessHandle.current();
            long started = process.info().startInstant().orElseThrow(() -> new IOException("OFFICE_PROCESS_IDENTITY_UNAVAILABLE")).toEpochMilli();
            member = new PetOfficeModeStore.Member(publisher().snapshot().instanceId(), process.pid(), started, "");
            modes.register(member);
        }
    }

    private void pollMode() throws IOException {
        PetOfficeModeStore.Control mode = modes.read();
        if (mode.mode() == PetOfficeModeStore.Mode.EXITING_OFFICE && owner.get() == null) {
            var intent = new PetOfficeRecoveryStore(directory).read();
            if (intent != null && !intent.enabled()) {
                var available = PetOfficeRuntimeLease.tryAcquire(directory);
                if (available.isPresent()) {
                    try (var administrative = available.get()) {
                        if (modes.read().equals(mode)) {
                            modes.commitOverlay(administrative);
                        }
                    }
                    mode = modes.read();
                }
            }
        }
        PetOfficeModeStore.Control observed = mode;
        observedMode = observed;
        boolean allow = observed.mode() == PetOfficeModeStore.Mode.IDE_OVERLAY;
        if (!allow) {
            com.github.claudecodegui.pet.CodexPetFloatingService.revokeOfficeOverlayPermission();
        }
        if (member.acknowledgedEpoch().equals(observed.epoch())
                && com.github.claudecodegui.pet.CodexPetFloatingService.officeOverlayPermitted() == allow || !modeUiQueued.compareAndSet(false, true)) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            boolean acknowledged = false;
            try {
                if (!disposed.get() && observed.equals(observedMode)) {
                    acknowledged = com.github.claudecodegui.pet.CodexPetFloatingService.reconcileOfficeDisplay(allow);
                }
            } finally {
                boolean complete = acknowledged;
                try {
                    worker.execute(() -> {
                        try {
                            if (complete && !disposed.get() && observed.equals(observedMode) && observed.epoch().equals(modes.read().epoch())) {
                                var acknowledgedMember = new PetOfficeModeStore.Member(member.id(), member.pid(), member.startedAt(), observed.epoch());
                                modes.register(acknowledgedMember);
                                member = acknowledgedMember;
                            }
                        } catch (IOException failure) {
                            com.github.claudecodegui.pet.CodexPetFloatingService.revokeOfficeOverlayPermission();
                        } finally {
                            modeUiQueued.set(false);
                        }
                    });
                } catch (RejectedExecutionException stopped) {
                    modeUiQueued.set(false);
                }
            }
        }, com.intellij.openapi.application.ModalityState.any());
    }

    private void detachAfterModeFailure() {
        observedMode = null;
        com.github.claudecodegui.pet.CodexPetFloatingService.revokeOfficeOverlayPermission();
        if (modeUiQueued.compareAndSet(false, true)) {
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    com.github.claudecodegui.pet.CodexPetFloatingService.reconcileOfficeDisplay(false);
                } finally {
                    modeUiQueued.set(false);
                }
            }, com.intellij.openapi.application.ModalityState.any());
        }
    }

    private void dispatch(PetOfficeIpcClient observed, PetOfficeRouteBroker.Command command, long began) {
        long receivedAt = began - TimeUnit.MILLISECONDS.toNanos(PetOfficeRouteBroker.DEADLINE_MILLIS - command.remainingMillis());
        publisher().navigator().navigate(observed.navigationPage(), command.request(),
                () -> !disposed.get() && client == observed && !observed.isClosed(), result -> {
                    try {
                        worker.execute(() -> {
                            if (client != observed || observed.isClosed() || disposed.get()) {
                                return;
                            }
                            try {
                                observed.complete(command, result);
                            } catch (IOException failure) {
                                fail(code(failure));
                            }
                        });
                    } catch (RejectedExecutionException stopped) {
                        // A disposed participant never replays navigation through a replacement connection.
                    }
                }, receivedAt);
    }

    private void recover() {
        if (disposed.get() || owner.get() != null || directory == null || nextRecovery != 0 && System.nanoTime() - nextRecovery < 0) {
            return;
        }
        nextRecovery = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(3000 + ThreadLocalRandom.current().nextLong(1000));
        try {
            var intent = new PetOfficeRecoveryStore(directory).read();
            if (intent != null && intent.enabled()) {
                PetOfficePrototypeService.getInstance().recover(intent);
            }
        } catch (IOException unavailable) {
            // Invalid/unknown intent fails closed; only a valid durable opt-in permits election.
        }
    }

    private boolean connectCurrent() throws IOException {
        if (disposed.get()) {
            throw new IOException("OFFICE_RUNTIME_CLOSED");
        }
        PetOfficeEndpointStore.Endpoint endpoint = new PetOfficeEndpointStore(directory).read();
        if (endpoint == null) {
            disconnectClient();
            return false;
        }
        if (client == null || !endpoint.equals(joined)) {
            disconnectClient();
            PetOfficeSessionPublisher publisher = publisher();
            client = new PetOfficeIpcClient(endpoint, publisher.snapshot().instanceId());
            client.assetEndpoint(assetChannel().endpoint());
            joined = endpoint;
            publisher.setOfficeActive(true);
            lastPublication = 0;
        }
        return true;
    }

    private void fail(String code) {
        disconnectClient();
        Owner current = owner.get();
        if (current != null && !disposed.get() && !current.server().isRunning()) {
            current.server().close();
            PetOfficePrototypeService.getInstance().coordinatorLost(current.lease());
        }
        retryAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(backoffMillis + ThreadLocalRandom.current().nextLong(250));
        backoffMillis = Math.min(5000, backoffMillis * 2);
        if (!disposed.get() && !code.equals(lastError)) {
            lastError = code;
            LOG.warn("[PetOffice] " + code);
        }
    }

    private void disconnectClient() {
        if (client != null) {
            if (publisher != null) {
                publisher.navigator().closePage(client.navigationPage());
            }
            client.close();
            client = null;
        }
        joined = null;
        if (assetChannel != null) {
            assetChannel.close();
            assetChannel = null;
        }
        nextEndpointCheck = 0;
        if (publisher != null) {
            publisher.setOfficeActive(false);
        }
    }

    private PetOfficeSessionPublisher publisher() {
        if (publisher == null) {
            publisher = PetOfficeSessionPublisher.getInstance();
        }
        return publisher;
    }

    private static String code(Exception failure) {
        String message = failure.getMessage();
        return message != null && message.matches("OFFICE_[A-Z_]{1,56}") ? message : "OFFICE_IPC_UNAVAILABLE";
    }

    @Override
    public synchronized void dispose() {
        if (disposed.compareAndSet(false, true)) {
            if (timer != null) {
                timer.cancel(false);
            }
            Owner current = owner.get();
            if (current != null) {
                current.server().close();
                current.appearances().close();
            }
            observedMode = null;
            com.github.claudecodegui.pet.CodexPetFloatingService.revokeOfficeOverlayPermission();
            worker.execute(this::disconnectClient);
            // A live process is retired only after its native overlay has actually detached on the EDT.
            ApplicationManager.getApplication().invokeLater(() -> {
                boolean detached;
                try {
                    detached = com.github.claudecodegui.pet.CodexPetFloatingService.reconcileOfficeDisplay(false);
                } catch (RuntimeException failure) {
                    LOG.warn("[PetOffice] OFFICE_MEMBER_DETACH_PENDING");
                    worker.shutdown();
                    return;
                }
                try {
                    worker.execute(() -> {
                        try {
                            if (detached && modes != null && member != null) {
                                modes.retire(member);
                            }
                        } catch (IOException unavailable) {
                            LOG.warn("[PetOffice] OFFICE_MEMBER_CLEANUP_FAILED");
                        }
                    });
                } finally {
                    worker.shutdown();
                }
            }, com.intellij.openapi.application.ModalityState.any());
        }
    }
}
