package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;

import java.lang.ref.WeakReference;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Page-scoped navigation authority. Queued/expired requests cannot acquire a replacement target. */
public final class PetOfficeTabNavigator {
    private static final int MAX_PENDING = 16;
    private static final long DEADLINE_NANOS = 3_000_000_000L;
    private final PetOfficeSessionRegistry registry;
    private final Consumer<Runnable> uiDispatcher;
    private final LongSupplier nanoTime;
    private final Map<String, WeakReference<Target>> targets = new LinkedHashMap<>();
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final Map<String, String> recentRequests = new LinkedHashMap<>();

    public enum Result { ACTIVATED, ATTENTION_REQUESTED, TARGET_GONE, STALE_INTERACTION, UNAVAILABLE }

    public record Request(String requestId, String sourceKey, String routeGeneration, String interactionId) { }

    public interface Target {
        Result activateOfficeTarget(Request request, BooleanSupplier stillValid);
    }

    public PetOfficeTabNavigator(PetOfficeSessionRegistry registry, Consumer<Runnable> uiDispatcher) {
        this(registry, uiDispatcher, System::nanoTime);
    }

    PetOfficeTabNavigator(PetOfficeSessionRegistry registry, Consumer<Runnable> uiDispatcher, LongSupplier nanoTime) {
        this.registry = Objects.requireNonNull(registry);
        this.uiDispatcher = Objects.requireNonNull(uiDispatcher);
        this.nanoTime = Objects.requireNonNull(nanoTime);
    }

    public synchronized void register(String handle, Target target) {
        targets.entrySet().removeIf(entry -> entry.getValue().get() == null);
        if (targets.size() < PetOfficeSessionRegistry.MAX_SOURCES || targets.containsKey(handle)) {
            targets.put(handle, new WeakReference<>(target));
        }
    }

    public synchronized void unregister(String handle) {
        targets.remove(handle);
    }

    public void navigate(String page, Request request, BooleanSupplier pageValid, Consumer<Result> completed) {
        navigate(page, request, pageValid, completed, nanoTime.getAsLong());
    }

    void navigate(String page, Request request, BooleanSupplier pageValid, Consumer<Result> completed, long receivedAt) {
        Pending action = new Pending(page, request, pageValid, completed, receivedAt);
        boolean accepted;
        synchronized (this) {
            accepted = pending.size() < MAX_PENDING && !pending.containsKey(request.requestId()) && !recentRequests.containsKey(request.requestId());
            if (accepted) {
                pending.put(request.requestId(), action);
                recentRequests.put(request.requestId(), page);
                while (recentRequests.size() > 64) {
                    recentRequests.remove(recentRequests.keySet().iterator().next());
                }
            }
        }
        if (!accepted) {
            completed.accept(Result.UNAVAILABLE);
            return;
        }
        try {
            uiDispatcher.accept(() -> execute(action));
        } catch (RuntimeException failure) {
            finish(action, Result.UNAVAILABLE);
        }
    }

    private void execute(Pending action) {
        Result result = Result.UNAVAILABLE;
        try {
            if (valid(action)) {
                PetOfficeSessionRegistry.RouteValidation validation = validate(action.request);
                if (validation == PetOfficeSessionRegistry.RouteValidation.AVAILABLE) {
                    Target target;
                    synchronized (this) {
                        String handle = PetOfficeSessionRegistry.parseKey(action.request.sourceKey()).contentHandleId();
                        WeakReference<Target> reference = targets.get(handle);
                        target = reference == null ? null : reference.get();
                    }
                    result = target == null ? Result.TARGET_GONE : target.activateOfficeTarget(action.request,
                            () -> valid(action) && validate(action.request) == PetOfficeSessionRegistry.RouteValidation.AVAILABLE);
                } else {
                    result = Result.valueOf(validation.name());
                }
            }
        } catch (RuntimeException failure) {
            result = Result.UNAVAILABLE;
        }
        finish(action, result);
    }

    private PetOfficeSessionRegistry.RouteValidation validate(Request request) {
        return registry.validateRoute(request.sourceKey(), request.routeGeneration(), request.interactionId());
    }

    /** Recheck the owning tab itself, covering a binding replacement before observer notification completes. */
    public static Result validateBinding(Request request, SessionExecutionState.Snapshot execution) {
        if (!PetOfficeSessionRegistry.parseKey(request.sourceKey()).bindingEpoch().equals(execution.bindingEpoch())) {
            return Result.TARGET_GONE;
        }
        if (!request.interactionId().isEmpty() && !request.interactionId().equals(execution.pendingInteractionId())) {
            return Result.STALE_INTERACTION;
        }
        return Result.ACTIVATED;
    }

    private synchronized boolean valid(Pending action) {
        return pending.get(action.request.requestId()) == action && !expired(action) && action.pageValid.getAsBoolean();
    }

    private boolean expired(Pending action) {
        return nanoTime.getAsLong() - action.startedAt >= DEADLINE_NANOS;
    }

    private void finish(Pending action, Result result) {
        boolean deliver;
        synchronized (this) {
            deliver = pending.remove(action.request.requestId(), action) && action.pageValid.getAsBoolean();
        }
        if (deliver) {
            action.completed.accept(result);
        }
    }

    public synchronized void closePage(String page) {
        pending.values().removeIf(value -> value.page.equals(page));
        recentRequests.values().removeIf(page::equals);
    }

    public synchronized void clear() {
        pending.clear();
        targets.clear();
        recentRequests.clear();
    }

    private record Pending(String page, Request request, BooleanSupplier pageValid, Consumer<Result> completed, long startedAt) { }
}
