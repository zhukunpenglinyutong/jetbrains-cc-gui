package com.github.claudecodegui.provider;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;

/**
 * Reads user-configured model context windows from {@code ~/.codemoss/config.json}.
 */
public final class CustomModelContextWindowProvider {

    private static final Logger LOG = Logger.getInstance(CustomModelContextWindowProvider.class);
    private static final String ROOT_KEY = "customModelContextWindows";
    private static final String CODEX_PROVIDER = "codex";
    private static final int TOKENS_PER_K = 1_000;

    private static volatile CustomModelContextWindowProvider instance;

    private final ConfigPathManager pathManager;
    private final Gson gson;
    private volatile CachedContextWindows cache;

    private CustomModelContextWindowProvider() {
        this(new ConfigPathManager());
    }

    CustomModelContextWindowProvider(ConfigPathManager pathManager) {
        this.pathManager = pathManager;
        this.gson = new Gson();
    }

    public static CustomModelContextWindowProvider getInstance() {
        CustomModelContextWindowProvider local = instance;
        if (local == null) {
            synchronized (CustomModelContextWindowProvider.class) {
                local = instance;
                if (local == null) {
                    local = new CustomModelContextWindowProvider();
                    instance = local;
                }
            }
        }
        return local;
    }

    @org.jetbrains.annotations.TestOnly
    public static void setInstanceForTests(CustomModelContextWindowProvider testInstance) {
        instance = testInstance;
    }

    @org.jetbrains.annotations.TestOnly
    public static CustomModelContextWindowProvider createForTests(Path configFilePath) {
        return new CustomModelContextWindowProvider(new ConfigPathManager() {
            @Override
            public Path getConfigFilePath() {
                return configFilePath;
            }
        });
    }

    public OptionalInt getContextWindow(String provider, String modelId) {
        if (provider == null || modelId == null || modelId.isBlank()) {
            return OptionalInt.empty();
        }

        String normalizedProvider = normalizeProvider(provider);
        if (!CODEX_PROVIDER.equals(normalizedProvider)) {
            return OptionalInt.empty();
        }

        Integer contextWindow = getOrLoad().forProvider(CODEX_PROVIDER).get(modelId.trim());
        return contextWindow == null ? OptionalInt.empty() : OptionalInt.of(contextWindow);
    }

    public void invalidateCache() {
        cache = null;
    }

    private CachedContextWindows getOrLoad() {
        Path configPath = pathManager.getConfigFilePath();
        long mtime = readMtimeSafe(configPath);
        CachedContextWindows current = cache;
        if (current != null && current.mtime == mtime) {
            return current;
        }

        synchronized (this) {
            current = cache;
            if (current != null && current.mtime == mtime) {
                return current;
            }
            CachedContextWindows loaded = load(configPath, mtime);
            cache = loaded;
            return loaded;
        }
    }

    private CachedContextWindows load(Path configPath, long mtime) {
        Map<String, Map<String, Integer>> empty = Map.of();
        if (!Files.exists(configPath)) {
            return new CachedContextWindows(mtime, empty);
        }

        try {
            JsonObject config = gson.fromJson(Files.readString(configPath), JsonObject.class);
            if (config == null || !config.has(ROOT_KEY) || !config.get(ROOT_KEY).isJsonObject()) {
                return new CachedContextWindows(mtime, empty);
            }

            JsonObject root = config.getAsJsonObject(ROOT_KEY);
            if (!root.has(CODEX_PROVIDER) || !root.get(CODEX_PROVIDER).isJsonObject()) {
                return new CachedContextWindows(mtime, empty);
            }

            JsonObject providerNode = root.getAsJsonObject(CODEX_PROVIDER);
            Map<String, Integer> modelMap = new HashMap<>();
            for (String modelId : providerNode.keySet()) {
                Integer contextWindow = readContextWindow(providerNode.get(modelId));
                if (contextWindow != null) {
                    modelMap.put(modelId, contextWindow);
                }
            }
            return new CachedContextWindows(mtime, Map.of(CODEX_PROVIDER, Map.copyOf(modelMap)));
        } catch (Exception e) {
            LOG.warn("[CustomModelContextWindowProvider] Failed to read config: " + e.getMessage());
            return new CachedContextWindows(mtime, empty);
        }
    }

    private static Integer readContextWindow(JsonElement element) {
        if (element == null || element.isJsonNull() || !element.isJsonPrimitive()) {
            return null;
        }
        try {
            int value = element.getAsBigDecimal().intValueExact();
            return value >= TOKENS_PER_K && value % TOKENS_PER_K == 0 ? value : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String normalizeProvider(String provider) {
        return provider.trim().toLowerCase(Locale.ROOT);
    }

    private static long readMtimeSafe(Path path) {
        try {
            FileTime time = Files.getLastModifiedTime(path);
            return time == null ? 0L : time.toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private static final class CachedContextWindows {
        final long mtime;
        final Map<String, Map<String, Integer>> byProvider;

        CachedContextWindows(long mtime, Map<String, Map<String, Integer>> byProvider) {
            this.mtime = mtime;
            this.byProvider = byProvider;
        }

        Map<String, Integer> forProvider(String provider) {
            return byProvider.getOrDefault(provider, Map.of());
        }
    }
}
