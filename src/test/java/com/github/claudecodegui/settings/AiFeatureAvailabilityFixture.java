package com.github.claudecodegui.settings;

import com.github.claudecodegui.cli.CliStatusDetector;
import com.github.claudecodegui.cli.CliToolId;
import com.github.claudecodegui.cli.CliToolStatus;
import com.github.claudecodegui.util.PlatformUtils;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** Scopes settings-resolution tests to fixture CLI availability, without probing host installations. */
final class AiFeatureAvailabilityFixture implements AutoCloseable {
    private final Field cacheField;
    private final Field homeField;
    private final Object originalCache;
    private final Object originalHome;
    private final Map<String, CliToolStatus> statuses = new LinkedHashMap<>();

    AiFeatureAvailabilityFixture() throws ReflectiveOperationException {
        cacheField = CliStatusDetector.class.getDeclaredField("detectAllCache");
        cacheField.setAccessible(true);
        homeField = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        homeField.setAccessible(true);
        originalCache = cacheField.get(null);
        originalHome = homeField.get(null);
        for (CliToolId tool : CliToolId.values()) {
            statuses.put(tool.getId(), CliToolStatus.notInstalled(tool));
        }
        publishAvailability();
    }

    void useHome(Path home) throws IllegalAccessException {
        homeField.set(null, home.toString());
    }

    void installCodex(Path home) throws ReflectiveOperationException {
        statuses.put("codex", CliToolStatus.installed(CliToolId.CODEX, "0.117.0",
                home.resolve("fixture-cli/codex").toString()));
        publishAvailability();
    }

    private void publishAvailability() throws ReflectiveOperationException {
        Class<?> cachedDetection = Class.forName(CliStatusDetector.class.getName() + "$CachedDetection");
        Constructor<?> constructor = cachedDetection.getDeclaredConstructor(Map.class, long.class);
        constructor.setAccessible(true);
        cacheField.set(null, constructor.newInstance(Map.copyOf(statuses), System.currentTimeMillis()));
    }

    @Override
    public void close() throws IllegalAccessException {
        try {
            cacheField.set(null, originalCache);
        } finally {
            // A previously uninitialized home must also be restored to null.
            homeField.set(null, originalHome);
        }
    }
}
