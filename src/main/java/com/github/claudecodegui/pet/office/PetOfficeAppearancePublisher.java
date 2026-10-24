package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.pet.CodexPetFloatingService.VisualConfiguration;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Supplier;

/** Source-owned admitted art. Transports immutable bytes, never local asset IDs or paths. */
final class PetOfficeAppearancePublisher implements AutoCloseable {
    private final Supplier<PetOfficeSessionRegistry.CompleteSnapshot> snapshots;
    private final Function<String, VisualConfiguration> configurations;
    private final PetOfficeAppearanceService assets;
    private Map<String, Selection> selections = Map.of();
    private volatile boolean closed;
    private final java.util.concurrent.locks.ReentrantLock access = new java.util.concurrent.locks.ReentrantLock();

    private record Selection(String projectId, VisualConfiguration configuration, PetOfficeAppearanceService.Appearance appearance) { }

    PetOfficeAppearancePublisher(Supplier<PetOfficeSessionRegistry.CompleteSnapshot> snapshots,
                                 Function<String, VisualConfiguration> configurations, PetOfficeAppearanceService assets) {
        this.snapshots = snapshots;
        this.configurations = configurations;
        this.assets = assets;
    }

    Map<String, PetOfficeAppearanceService.Appearance> catalog() throws IOException {
        access.lock();
        try {
            if (closed) {
                throw new IOException("OFFICE_RUNTIME_CLOSED");
            }
            assets.beginSnapshot();
            Map<String, VisualConfiguration> projects = new LinkedHashMap<>();
            Map<String, Selection> next = new LinkedHashMap<>();
            var ordered = snapshots.get().sources().stream().sorted(java.util.Comparator.comparing(source ->
                    source.execution().phase() == com.github.claudecodegui.session.SessionExecutionState.Phase.IDLE)).toList();
            for (var source : ordered) {
                String project = source.metadata().projectId();
                if (!projects.containsKey(project)) {
                    projects.put(project, configurations.apply(project));
                }
                var config = projects.get(project);
                next.put(PetOfficeSessionRegistry.key(source.sourceKey()), new Selection(project, config, assets.resolve(config)));
            }
            selections = Map.copyOf(next);
            Map<String, PetOfficeAppearanceService.Appearance> result = new LinkedHashMap<>();
            selections.forEach((key, selection) -> { if (valid(key, selection)) { result.put(key, selection.appearance()); } });
            return Map.copyOf(result);
        } finally {
            release();
        }
    }

    byte[] bytes(String sourceKey, String revision, String digest) throws IOException {
        access.lock();
        try {
            catalog();
            if (!current(sourceKey, revision, digest)) {
                throw new IOException("OFFICE_ASSET_STALE");
            }
            byte[] bytes = assets.bytes(selections.get(sourceKey).appearance().manifest());
            if (bytes == null) {
                throw new IOException("OFFICE_ASSET_RETRY");
            }
            return bytes;
        } finally {
            release();
        }
    }

    boolean current(String sourceKey, String revision, String digest) {
        access.lock();
        try {
            Selection selection = selections.get(sourceKey);
            return !closed && selection != null && selection.appearance().revision().equals(revision)
                    && selection.appearance().manifest().digest().equals(digest) && valid(sourceKey, selection);
        } finally {
            release();
        }
    }

    private boolean valid(String key, Selection selection) {
        return java.util.Objects.equals(selection.configuration(), configurations.apply(selection.projectId()))
                && snapshots.get().sources().stream().anyMatch(source -> PetOfficeSessionRegistry.key(source.sourceKey()).equals(key));
    }

    @Override
    public void close() {
        closed = true;
        if (access.tryLock()) {
            release();
        }
    }

    private void release() {
        try {
            if (closed) {
                selections = Map.of();
                assets.clear();
            }
        } finally {
            access.unlock();
        }
    }
}
