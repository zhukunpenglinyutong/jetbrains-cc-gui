package com.github.claudecodegui.pet.office;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** At most two asynchronous metadata fetches; failed/old connections grant no appearance authority. */
final class PetOfficeRemoteAppearances implements AutoCloseable {
    private record Catalog(PetOfficeParticipantRegistry.AssetRoute route, Map<String, PetOfficeAppearanceService.Appearance> values, long updatedAt) { }
    private final String requester;
    private final PetOfficeParticipantRegistry registry;
    private final BooleanSupplier owns;
    private final Map<String, Catalog> catalogs = new ConcurrentHashMap<>();
    private final Set<String> loading = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> attempts = new ConcurrentHashMap<>();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new SynchronousQueue<>(),
            task -> PetOfficeIpcServer.daemon(task, "Pet Office remote appearance"));

    PetOfficeRemoteAppearances(String requester, PetOfficeParticipantRegistry registry, BooleanSupplier owns) {
        this.requester = requester;
        this.registry = registry;
        this.owns = owns;
    }

    Map<String, PetOfficeAppearanceService.Appearance> view(PetOfficeSessionRegistry.CompleteSnapshot snapshot) {
        Set<String> participants = snapshot.sources().stream().map(source -> source.sourceKey().instanceId()).collect(java.util.stream.Collectors.toSet());
        catalogs.keySet().retainAll(participants);
        attempts.keySet().retainAll(participants);
        Map<String, PetOfficeAppearanceService.Appearance> result = new LinkedHashMap<>();
        for (String participant : participants.stream().sorted(java.util.Comparator.comparingLong(id -> attempts.getOrDefault(id, 0L))).toList()) {
            var route = registry.assetRoute(participant);
            if (route == null) {
                catalogs.remove(participant);
                continue;
            }
            Catalog catalog = catalogs.get(participant);
            if (catalog != null && catalog.route().connection() == route.connection() && registry.assetCurrent(catalog.route())) {
                result.putAll(catalog.values());
            }
            if (!closed.get() && owns.getAsBoolean() && (catalog == null || catalog.route().connection() != route.connection()
                    || System.nanoTime() - catalog.updatedAt() >= TimeUnit.SECONDS.toNanos(2)) && loading.add(participant)) {
                Long previous = attempts.put(participant, System.nanoTime());
                try {
                    workers.execute(() -> {
                        try {
                            var values = PetOfficeAssetChannel.catalog(route.endpoint(), requester, () -> current(route));
                            if (current(route)) {
                                catalogs.put(participant, new Catalog(route, values, System.nanoTime()));
                            }
                        } catch (IOException | RuntimeException unavailable) {
                            // Retry without replacing a current complete catalog or delaying control traffic.
                        } finally {
                            loading.remove(participant);
                        }
                    });
                } catch (java.util.concurrent.RejectedExecutionException busy) {
                    loading.remove(participant);
                    if (previous == null) {
                        attempts.remove(participant);
                    } else {
                        attempts.put(participant, previous);
                    }
                }
            }
        }
        result.keySet().retainAll(snapshot.sources().stream().map(source -> PetOfficeSessionRegistry.key(source.sourceKey())).collect(java.util.stream.Collectors.toSet()));
        return Map.copyOf(result);
    }

    byte[] bytes(String key, PetOfficeAppearanceService.Appearance appearance, BooleanSupplier pageValid) throws IOException {
        String participant = PetOfficeSessionRegistry.parseKey(key).instanceId();
        Catalog catalog = catalogs.get(participant);
        if (catalog == null || !appearance.equals(catalog.values().get(key)) || !current(catalog.route()) || !pageValid.getAsBoolean()) {
            throw new IOException("OFFICE_ASSET_STALE");
        }
        return PetOfficeAssetChannel.asset(catalog.route().endpoint(), requester, key, appearance, () -> {
            Catalog latest = catalogs.get(participant);
            return current(catalog.route()) && pageValid.getAsBoolean() && latest != null && latest.route().equals(catalog.route())
                    && appearance.equals(latest.values().get(key));
        });
    }

    private boolean current(PetOfficeParticipantRegistry.AssetRoute route) {
        return !closed.get() && owns.getAsBoolean() && registry.assetCurrent(route);
    }

    @Override
    public void close() {
        closed.set(true);
        attempts.clear();
        catalogs.clear();
        workers.shutdownNow();
    }
}
