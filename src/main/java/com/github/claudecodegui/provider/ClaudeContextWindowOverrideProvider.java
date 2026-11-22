package com.github.claudecodegui.provider;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Resolves the explicit Claude context window override.
 *
 * <p>The Claude CLI reads {@code CLAUDE_CODE_MAX_CONTEXT_TOKENS} from the merged {@code env}
 * of its settings files (managed &gt; project local &gt; project &gt; user, the same order the
 * CLI applies) and falls back to the inherited process env. That value drives its own context
 * accounting, which is what {@code /context} reports. Claude SDK usage payloads do not carry a
 * context-window field, so the plugin must resolve the same override instead of falling back
 * to the static per-model table. {@code DISABLE_COMPACT} is resolved the same way because it
 * changes how the CLI applies the override.</p>
 */
public final class ClaudeContextWindowOverrideProvider {

    static final String ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
    static final String DISABLE_COMPACT_KEY = "DISABLE_COMPACT";

    /** Values the CLI treats as true for boolean env flags. */
    private static final Set<String> TRUTHY_VALUES = Set.of("1", "true", "yes", "on");

    private static final String PROJECT_CONFIG_DIR = ".claude";
    private static final String PROJECT_SETTINGS_FILE = "settings.json";
    private static final String LOCAL_SETTINGS_FILE = "settings.local.json";

    private static final Logger LOG = Logger.getInstance(ClaudeContextWindowOverrideProvider.class);

    private static volatile ClaudeContextWindowOverrideProvider instance;

    private final ConfigPathManager pathManager;
    private final Map<Path, CachedEnv> cache = new ConcurrentHashMap<>();

    private ClaudeContextWindowOverrideProvider() {
        this(new ConfigPathManager());
    }

    ClaudeContextWindowOverrideProvider(ConfigPathManager pathManager) {
        this.pathManager = pathManager;
    }

    public static ClaudeContextWindowOverrideProvider getInstance() {
        ClaudeContextWindowOverrideProvider local = instance;
        if (local == null) {
            synchronized (ClaudeContextWindowOverrideProvider.class) {
                local = instance;
                if (local == null) {
                    local = new ClaudeContextWindowOverrideProvider();
                    instance = local;
                }
            }
        }
        return local;
    }

    @org.jetbrains.annotations.TestOnly
    public static void setInstanceForTests(ClaudeContextWindowOverrideProvider testInstance) {
        instance = testInstance;
    }

    /**
     * Test provider reading only {@code userSettingsPath}; managed settings point at a file
     * that does not exist so a developer machine's managed config never leaks in.
     */
    @org.jetbrains.annotations.TestOnly
    public static ClaudeContextWindowOverrideProvider createForTests(Path userSettingsPath) {
        return createForTests(userSettingsPath,
                userSettingsPath.resolveSibling(userSettingsPath.getFileName() + ".managed-absent"));
    }

    @org.jetbrains.annotations.TestOnly
    public static ClaudeContextWindowOverrideProvider createForTests(Path userSettingsPath, Path managedSettingsPath) {
        return new ClaudeContextWindowOverrideProvider(new ConfigPathManager() {
            @Override
            public Path getClaudeSettingsPath() {
                return userSettingsPath;
            }

            @Override
            public Path getManagedSettingsPath() {
                return managedSettingsPath;
            }
        });
    }

    /**
     * @param cwd session working directory used for project-level settings, or null when unknown
     * @return the configured context window in tokens, or empty when no override is set
     */
    public OptionalInt getOverride(String cwd) {
        return parsePositiveInt(resolveEnvValue(ENV_KEY, cwd));
    }

    /**
     * With auto-compact disabled the CLI applies the override to every model.
     *
     * @param cwd session working directory used for project-level settings, or null when unknown
     */
    public boolean isCompactDisabled(String cwd) {
        String value = resolveEnvValue(DISABLE_COMPACT_KEY, cwd);
        return value != null && TRUTHY_VALUES.contains(value.trim().toLowerCase(Locale.ROOT));
    }

    /**
     * Resolves one env key the way the CLI merges settings: the highest-precedence settings
     * file that defines the key wins, and the inherited process env is the last fallback.
     */
    String resolveEnvValue(String key, String cwd) {
        for (Path settingsPath : settingsPathsByPrecedence(cwd)) {
            String value = readEnvValue(settingsPath, key);
            if (value != null) {
                return value;
            }
        }
        return System.getenv(key);
    }

    /**
     * The bridge resolves model-family mappings from the user-level settings only.
     *
     * @return a copy of the {@code env} block in {@code ~/.claude/settings.json}, or null when absent
     */
    public JsonObject getUserSettingsEnv() {
        JsonObject env = readEnv(pathManager.getClaudeSettingsPath());
        return env == null ? null : env.deepCopy();
    }

    List<Path> settingsPathsByPrecedence(String cwd) {
        List<Path> paths = new ArrayList<>(4);
        paths.add(pathManager.getManagedSettingsPath());
        if (cwd != null && !cwd.isBlank()) {
            try {
                Path projectConfigDir = Paths.get(cwd).resolve(PROJECT_CONFIG_DIR);
                paths.add(projectConfigDir.resolve(LOCAL_SETTINGS_FILE));
                paths.add(projectConfigDir.resolve(PROJECT_SETTINGS_FILE));
            } catch (InvalidPathException e) {
                LOG.debug("[ClaudeContextWindowOverrideProvider] Ignoring invalid cwd: " + cwd);
            }
        }
        paths.add(pathManager.getClaudeSettingsPath());
        return List.copyOf(paths);
    }

    OptionalInt readOverride(Path settingsPath) {
        return parsePositiveInt(readEnvValue(settingsPath, ENV_KEY));
    }

    private String readEnvValue(Path settingsPath, String key) {
        JsonObject env = readEnv(settingsPath);
        if (env == null) {
            return null;
        }
        JsonElement raw = env.get(key);
        return raw != null && raw.isJsonPrimitive() ? raw.getAsString() : null;
    }

    private JsonObject readEnv(Path settingsPath) {
        if (settingsPath == null) {
            return null;
        }
        long mtime = readMtimeSafe(settingsPath);
        CachedEnv current = cache.get(settingsPath);
        if (current != null && current.mtime == mtime) {
            return current.env;
        }
        CachedEnv loaded = new CachedEnv(mtime, loadEnv(settingsPath));
        cache.put(settingsPath, loaded);
        return loaded.env;
    }

    private static JsonObject loadEnv(Path settingsPath) {
        if (!Files.exists(settingsPath)) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(settingsPath, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) {
                return null;
            }
            JsonObject settings = parsed.getAsJsonObject();
            if (!settings.has("env") || !settings.get("env").isJsonObject()) {
                return null;
            }
            return settings.getAsJsonObject("env");
        } catch (Exception e) {
            LOG.warn("[ClaudeContextWindowOverrideProvider] Failed to read settings: " + e.getMessage());
            return null;
        }
    }

    static OptionalInt parsePositiveInt(String raw) {
        if (raw == null) {
            return OptionalInt.empty();
        }
        try {
            int value = Integer.parseInt(raw.trim());
            return value > 0 ? OptionalInt.of(value) : OptionalInt.empty();
        } catch (NumberFormatException e) {
            return OptionalInt.empty();
        }
    }

    private static long readMtimeSafe(Path path) {
        try {
            FileTime time = Files.getLastModifiedTime(path);
            return time == null ? 0L : time.toMillis();
        } catch (Exception e) {
            return 0L;
        }
    }

    /**
     * Parsed {@code env} block of one settings file. The object is never handed out
     * directly, so it stays effectively immutable once cached.
     */
    private static final class CachedEnv {
        final long mtime;
        final JsonObject env;

        CachedEnv(long mtime, JsonObject env) {
            this.mtime = mtime;
            this.env = env;
        }
    }
}
