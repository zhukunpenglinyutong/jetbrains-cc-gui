package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.util.SafeJsonFileOps;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * Claude Settings Manager.
 * Manages reading, writing, and syncing of ~/.claude/settings.json.
 */
public class ClaudeSettingsManager {
    private static final Logger LOG = Logger.getInstance(ClaudeSettingsManager.class);

    /** Read attempts when another process may be mid-write of a shared config. */
    private static final int READ_ATTEMPTS = 3;
    /** Delay between read attempts (ms). */
    private static final long READ_RETRY_DELAY_MS = 100;
    /** Read/re-apply rounds for one settings.json mutation before it fails explicitly. */
    private static final int MUTATION_ATTEMPTS = 3;

    /**
     * System-protected fields - these should never be overridden by provider configs
     * and are always preserved from the existing configuration.
     */
    static final Set<String> PROTECTED_SYSTEM_FIELDS = Set.of(
            "mcpServers",           // MCP server configuration
            "disabledMcpServers",   // Disabled MCP servers
            "plugins",              // Skills/Plugins configuration
            "trustedDirectories",   // Trusted directories
            "trustedFiles"          // Trusted files
    );

    /**
     * Provider-managed fields - only these fields will be overridden by provider configs.
     * All other user-customized fields are preserved.
     */
    static final Set<String> PROVIDER_MANAGED_FIELDS = Set.of(
            "env",                      // Environment variables (key-level merge; see ClaudeSettingsSyncPlan)
            "model",                    // Model selection
            "modelPicker",              // Provider model catalog
            "alwaysThinkingEnabled",    // Thinking mode
            "codemossProviderId",       // Codemoss provider identifier
            "ccSwitchProviderId",       // CC-Switch provider identifier
            "maxContextLengthTokens",   // Maximum context length
            "temperature",              // Temperature parameter
            "topP",                     // Top-P parameter
            "topK"                      // Top-K parameter
    );

    private final Gson gson;
    private final ConfigPathManager pathManager;

    public ClaudeSettingsManager(Gson gson, ConfigPathManager pathManager) {
        this.gson = gson;
        this.pathManager = pathManager;
    }

    /**
     * Create default Claude Settings.
     */
    public JsonObject createDefaultClaudeSettings() {
        JsonObject settings = new JsonObject();
        settings.add("env", new JsonObject());
        return settings;
    }

    /**
     * Read Claude Settings for display and decision paths.
     *
     * <p>Lenient and READ-ONLY: a corrupt file falls back to the plugin backup
     * copy (never written back over the live file), and a missing file yields
     * the default object. Read-modify-write callers must use
     * {@link #readClaudeSettingsForUpdate()} instead — deriving a write from
     * this fallback would replace an unreadable file with a fabricated document.
     */
    public JsonObject readClaudeSettings() throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        File settingsFile = settingsPath.toFile();

        if (!settingsFile.exists()) {
            return createDefaultClaudeSettings();
        }

        JsonObject healed = SafeJsonFileOps.readJsonOrBackup(
                settingsPath, READ_ATTEMPTS, READ_RETRY_DELAY_MS);
        return healed != null ? healed : createDefaultClaudeSettings();
    }

    /**
     * Read Claude Settings for a read-modify-write cycle.
     *
     * @return the parsed settings, or a default object when the file does not exist
     * @throws IOException when the file exists but cannot be parsed: any write derived
     *                     from a fallback would overwrite the user's real file
     */
    public JsonObject readClaudeSettingsForUpdate() throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        if (!Files.exists(settingsPath)) {
            return createDefaultClaudeSettings();
        }
        JsonObject parsed = SafeJsonFileOps.readJsonObjectStrict(settingsPath, READ_ATTEMPTS, READ_RETRY_DELAY_MS);
        return parsed != null ? parsed : createDefaultClaudeSettings();
    }

    /**
     * Apply a mutation to settings.json with optimistic concurrency control.
     *
     * <p>The mutation is re-planned against the freshest content on every
     * attempt, and the replace only happens when the file still matches the
     * fingerprint taken before the read. A concurrent writer (provider sync in
     * another window, the CLI) therefore wins its update instead of being
     * silently overwritten with a stale snapshot.
     *
     * @param mutation returns true when the settings it received must be written
     * @throws IOException when the file stays unreadable or keeps changing
     */
    private void updateClaudeSettings(Predicate<JsonObject> mutation) throws IOException {
        mutateClaudeSettings(current -> mutation.test(current) ? current : null);
    }

    /**
     * Run one settings.json read-modify-write cycle, retrying on conflicts.
     *
     * @param planner plans the write against the current content; returns the document
     *                to persist, or {@code null} when nothing needs to be written
     * @throws IOException when the file stays unreadable or keeps changing
     */
    private void mutateClaudeSettings(SettingsMutation planner) throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        IOException lastError = null;
        for (int attempt = 1; attempt <= MUTATION_ATTEMPTS; attempt++) {
            SafeJsonFileOps.ContentSnapshot expected = SafeJsonFileOps.snapshot(settingsPath);
            JsonObject current = readClaudeSettingsForUpdate();
            JsonObject next = planner.plan(current);
            if (next == null) {
                LOG.debug("[ClaudeSettingsManager] settings.json needs no update");
                return;
            }
            applyForcedSettings(next);
            try {
                SafeJsonFileOps.writeAtomicallyIfUnchanged(
                        settingsPath, expected, writer -> gson.toJson(next, writer));
                hardenFilePermissions(settingsPath);
                LOG.info("[ClaudeSettingsManager] Updated settings: " + settingsPath);
                return;
            } catch (SafeJsonFileOps.ConflictException conflict) {
                lastError = conflict;
                LOG.info("[ClaudeSettingsManager] settings.json changed while an update was applied (attempt "
                        + attempt + "/" + MUTATION_ATTEMPTS + ") — re-reading and re-applying");
                if (attempt < MUTATION_ATTEMPTS) {
                    pauseBeforeRetry();
                }
            }
        }
        throw new IOException("Could not update ~/.claude/settings.json after " + MUTATION_ATTEMPTS
                + " attempt(s): it kept changing concurrently", lastError);
    }

    /**
     * Planner for one settings.json mutation, re-invoked on every conflict retry.
     */
    @FunctionalInterface
    private interface SettingsMutation {
        /**
         * @param current the freshly read settings
         * @return the document to write, or {@code null} when no write is needed
         * @throws IOException when the plan cannot be applied to this content
         */
        JsonObject plan(JsonObject current) throws IOException;
    }

    /**
     * Force-write the plugin-managed settings every write must carry.
     *
     * @param settings the document about to be written (modified in place)
     */
    private static void applyForcedSettings(JsonObject settings) {
        JsonObject env;
        if (settings.has("env") && settings.get("env").isJsonObject()) {
            env = settings.getAsJsonObject("env");
        } else {
            env = new JsonObject();
            settings.add("env", env);
        }
        env.addProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    }

    /** Pause between conflict retries, preserving the interrupt status. */
    private static void pauseBeforeRetry() {
        try {
            Thread.sleep(READ_RETRY_DELAY_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Read managed settings from the platform-specific managed-settings.json.
     * Returns null if the file does not exist or cannot be parsed.
     */
    public JsonObject readManagedSettings() {
        try {
            Path managedPath = pathManager.getManagedSettingsPath();
            File managedFile = managedPath.toFile();

            if (!managedFile.exists()) {
                return null;
            }

            try (FileReader reader = new FileReader(managedFile)) {
                return JsonParser.parseReader(reader).getAsJsonObject();
            }
        } catch (Exception e) {
            LOG.debug("[ClaudeSettingsManager] Failed to read managed-settings.json: " + e.getMessage());
            return null;
        }
    }

    /**
     * Write Claude Settings.
     */
    public void writeClaudeSettings(JsonObject settings) throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        if (!Files.exists(settingsPath.getParent())) {
            Files.createDirectories(settingsPath.getParent());
        }

        applyForcedSettings(settings);

        // Atomic replace: never leave a truncated settings.json behind if the
        // IDE crashes or is killed mid-write (SafeJsonFileOps also keeps a
        // .ccgui-backup copy and preserves the file mode / symlink target).
        SafeJsonFileOps.writeAtomically(settingsPath, writer -> gson.toJson(settings, writer));
        LOG.info("[ClaudeSettingsManager] Synced settings to: " + settingsPath);
        // Security (J): settings.json may hold ANTHROPIC_AUTH_TOKEN; restrict to 0600.
        hardenFilePermissions(settingsPath);
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). No-op on non-POSIX
     * filesystems (e.g. Windows), where the per-user home directory ACL applies. (Security J)
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[ClaudeSettingsManager] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }

    /**
     * Sync MCP server configuration to Claude settings.json.
     * The Claude CLI reads MCP config from ~/.claude/settings.json at runtime.
     */
    public void syncMcpToClaudeSettings() throws IOException {
        // Default: guarded sync — an empty source mcpServers is treated as
        // suspicious (possible data loss) and never wipes a non-empty target.
        syncMcpToClaudeSettings(false);
    }

    /**
     * Sync MCP servers from ~/.claude.json to ~/.claude/settings.json.
     *
     * @param allowEmptyOverwrite {@code true} when the caller KNOWS the user
     *                            intentionally emptied the source (e.g. just
     *                            deleted their last server in the UI) and the
     *                            empty state must propagate to settings.json;
     *                            {@code false} keeps the loss guard active
     * @throws IOException on read/write failures
     */
    public void syncMcpToClaudeSettings(boolean allowEmptyOverwrite) throws IOException {
        Path claudeJsonPath = Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude.json");
        if (!Files.exists(claudeJsonPath)) {
            LOG.info("[ClaudeSettingsManager] ~/.claude.json not found, skipping MCP sync");
            return;
        }

        // Strict reads on both sides: a sync derived from unreadable content
        // would push a fabricated (empty or stale) server list into
        // settings.json. The source is re-read on every conflict retry so the
        // sync always speaks about the latest state, never an old snapshot.
        mutateClaudeSettings(settings -> {
            JsonObject claudeJson = SafeJsonFileOps.readJsonObjectStrict(
                    claudeJsonPath, READ_ATTEMPTS, READ_RETRY_DELAY_MS);
            if (claudeJson == null) {
                LOG.info("[ClaudeSettingsManager] ~/.claude.json disappeared, skipping MCP sync");
                return null;
            }
            return applyMcpServers(claudeJson, settings, allowEmptyOverwrite) ? settings : null;
        });
        LOG.info("[ClaudeSettingsManager] Successfully synced MCP configuration to ~/.claude/settings.json");
    }

    /**
     * Copy the MCP-related fields from ~/.claude.json into settings.json.
     *
     * <p>A missing {@code mcpServers} key in the source means "no servers", not
     * "unknown": when the caller knows the user emptied the list on purpose
     * ({@code allowEmptyOverwrite}) the empty state is written as an empty object
     * so a previously synced ghost disappears; otherwise the target list is kept
     * (loss guard against a CLI snapshot that predates the user's configuration).
     *
     * @param claudeJson          the freshly read source document
     * @param settings            the target settings (modified in place)
     * @param allowEmptyOverwrite whether an empty or absent source may clear the target
     * @return true when settings.json must be written
     */
    private boolean applyMcpServers(JsonObject claudeJson, JsonObject settings, boolean allowEmptyOverwrite) {
        boolean changed = false;
        JsonObject sourceServers = claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()
                ? claudeJson.getAsJsonObject("mcpServers")
                : null;
        boolean sourceEmpty = sourceServers == null || sourceServers.keySet().isEmpty();
        boolean targetHasServers = settings.has("mcpServers")
                && settings.get("mcpServers").isJsonObject()
                && !settings.getAsJsonObject("mcpServers").keySet().isEmpty();

        if (allowEmptyOverwrite && sourceEmpty && targetHasServers) {
            settings.add("mcpServers", new JsonObject());
            changed = true;
            LOG.info("[ClaudeSettingsManager] Cleared settings.json mcpServers: the source was intentionally emptied");
        } else if (sourceEmpty && targetHasServers) {
            LOG.warn("[ClaudeSettingsManager] Skipped syncing an empty mcpServers from ~/.claude.json "
                    + "over the non-empty mcpServers in settings.json (loss guard)");
        } else if (sourceServers != null) {
            settings.add("mcpServers", sourceServers);
            changed = true;
            LOG.info("[ClaudeSettingsManager] Synced mcpServers to settings.json (source servers: "
                    + sourceServers.keySet().size() + ")");
        }

        if (claudeJson.has("disabledMcpServers")) {
            settings.add("disabledMcpServers", claudeJson.get("disabledMcpServers"));
            changed = true;
            JsonArray disabledServers = claudeJson.getAsJsonArray("disabledMcpServers");
            LOG.info("[ClaudeSettingsManager] Synced " + disabledServers.size()
                    + " disabled MCP servers to settings.json");
        }
        return changed;
    }

    /**
     * Remove one MCP server from the settings.json copy, leaving every other
     * entry in place. Used when a delete happened outside ~/.claude.json, so a
     * full sync from that file would speak about the wrong store.
     *
     * @param serverId the deleted server id
     * @throws IOException when settings.json is unreadable or keeps changing
     */
    public void removeMcpServerFromClaudeSettings(String serverId) throws IOException {
        mutateClaudeSettings(settings -> {
            if (!settings.has("mcpServers") || !settings.get("mcpServers").isJsonObject()
                    || !settings.getAsJsonObject("mcpServers").has(serverId)) {
                return null;
            }
            settings.getAsJsonObject("mcpServers").remove(serverId);
            LOG.info("[ClaudeSettingsManager] Removed MCP server from settings.json: " + serverId);
            return settings;
        });
    }

    /**
     * Apply CLI login mode.
     *
     * Historical behavior (REMOVED): this method used to write CCGUI_CLI_LOGIN_AUTHORIZED=1
     * AND DELETE the user's ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from
     * ~/.claude/settings.json so that the Claude SDK would fall through to its native
     * OAuth flow. That destructively wiped user-configured keys with no recovery path.
     *
     * Current behavior: this is a no-op. The single source of truth for CLI login mode
     * is the plugin-owned ~/.codemoss/config.json (claude.current === "__cli_login__").
     * The Node.js bridge reads that file via getClaudeRuntimeState() in api-config.js
     * and clears process.env.ANTHROPIC_API_KEY at runtime — without ever touching
     * the user's ~/.claude/settings.json.
     *
     * Kept as a no-op (rather than deleted) to preserve the call site in
     * ClaudeProviderOperations.handleSwitchProvider for future hooks if needed.
     */
    public void applyCliLoginToClaudeSettings() throws IOException {
        LOG.info("[ClaudeSettingsManager] Switched to CLI login mode (settings.json untouched, API keys preserved)");
    }

    /**
     * Read OAuth account info from ~/.claude.json for UI display.
     * Only extracts safe display fields (email, name), never credentials or tokens.
     * @return JsonObject with filtered account info, or null if not available
     */
    public JsonObject readCliLoginAccountInfo() {
        try {
            String homeDir = NodeDetector.resolveHomeForFileOps();
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (!claudeJsonFile.exists()) {
                return null;
            }

            try (FileReader reader = new FileReader(claudeJsonFile, StandardCharsets.UTF_8)) {
                JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();
                if (claudeJson.has("oauthAccount") && !claudeJson.get("oauthAccount").isJsonNull()) {
                    JsonObject oauthAccount = claudeJson.getAsJsonObject("oauthAccount");
                    // Only extract safe display fields - never pass the full object
                    JsonObject safeInfo = new JsonObject();
                    if (oauthAccount.has("emailAddress")) {
                        safeInfo.addProperty("emailAddress", oauthAccount.get("emailAddress").getAsString());
                    }
                    if (oauthAccount.has("name")) {
                        safeInfo.addProperty("name", oauthAccount.get("name").getAsString());
                    }
                    return safeInfo;
                }
            }
        } catch (Exception e) {
            LOG.debug("[ClaudeSettingsManager] Failed to read CLI login account info: " + e.getMessage());
        }
        return null;
    }

    /**
     * Remove the legacy CCGUI_CLI_LOGIN_AUTHORIZED flag from settings.json if present.
     *
     * This flag is no longer written by the plugin (CLI login mode is tracked in
     * ~/.codemoss/config.json), but earlier versions did write it. This method cleans
     * up that residue when users switch away from CLI login mode, so the flag does
     * not leak into other auth flows.
     */
    public void removeCliLoginFromClaudeSettings() throws IOException {
        AtomicBoolean removed = new AtomicBoolean(false);
        updateClaudeSettings(settings -> {
            if (!settings.has("env") || !settings.get("env").isJsonObject()) {
                return false;
            }
            JsonObject env = settings.getAsJsonObject("env");
            if (!env.has("CCGUI_CLI_LOGIN_AUTHORIZED")) {
                return false;
            }
            env.remove("CCGUI_CLI_LOGIN_AUTHORIZED");
            removed.set(true);
            return true;
        });
        if (removed.get()) {
            LOG.info("[ClaudeSettingsManager] Removed CLI login authorization flag from settings.json");
        }
    }

    /**
     * Detect apiKeyHelper in user settings or managed settings.
     * @return true if apiKeyHelper is configured, false otherwise
     */
    private boolean hasApiKeyHelper(JsonObject claudeSettings) {
        if (claudeSettings.has("apiKeyHelper") && !claudeSettings.get("apiKeyHelper").isJsonNull()) {
            return true;
        }
        JsonObject managedSettings = readManagedSettings();
        return managedSettings != null && managedSettings.has("apiKeyHelper") && !managedSettings.get("apiKeyHelper").isJsonNull();
    }

    /**
     * Get the current configuration used by Claude CLI (~/.claude/settings.json).
     * Used to display the currently applied configuration on the settings page.
     */
    public JsonObject getCurrentClaudeConfig() throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        JsonObject result = new JsonObject();

        // Extract key settings from the env object
        if (claudeSettings.has("env")) {
            JsonObject env = claudeSettings.getAsJsonObject("env");

            // Support both auth methods: prefer ANTHROPIC_AUTH_TOKEN, fall back to ANTHROPIC_API_KEY
            String apiKey = "";
            String authType = "none";

            if (env.has("ANTHROPIC_AUTH_TOKEN") && !env.get("ANTHROPIC_AUTH_TOKEN").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_AUTH_TOKEN").getAsString();
                authType = "auth_token";  // Bearer authentication
            } else if (env.has("ANTHROPIC_API_KEY") && !env.get("ANTHROPIC_API_KEY").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_API_KEY").getAsString();
                authType = "api_key";  // x-api-key authentication
            }

            String baseUrl = env.has("ANTHROPIC_BASE_URL") ? env.get("ANTHROPIC_BASE_URL").getAsString() : "";

            // Check for CLI login authorization
            if (apiKey.isEmpty() && "none".equals(authType) &&
                    env.has("CCGUI_CLI_LOGIN_AUTHORIZED") &&
                    "1".equals(env.get("CCGUI_CLI_LOGIN_AUTHORIZED").getAsString())) {
                authType = "cli_login";
            }

            // If no API key found, check for apiKeyHelper in user settings or managed settings
            if (apiKey.isEmpty() && "none".equals(authType) && hasApiKeyHelper(claudeSettings)) {
                authType = "api_key_helper";
            }

            // Mask credentials – never expose full API keys to the webview.
            // Show only a safe prefix/suffix so the user can identify the key.
            result.addProperty("apiKey", maskCredential(apiKey));
            result.addProperty("authType", authType);  // Add auth type identifier
            result.addProperty("baseUrl", baseUrl);
        } else {
            // No env object — still check for apiKeyHelper
            String authType = hasApiKeyHelper(claudeSettings) ? "api_key_helper" : "none";
            result.addProperty("apiKey", "");
            result.addProperty("authType", authType);
            result.addProperty("baseUrl", "");
        }

        // If codemossProviderId exists, try to retrieve the provider name
        if (claudeSettings.has("codemossProviderId")) {
            String providerId = claudeSettings.get("codemossProviderId").getAsString();
            result.addProperty("providerId", providerId);
        }

        return result;
    }

    /**
     * Mask a credential string for safe display.
     * Shows the first 4 and last 4 characters with asterisks in between.
     * Returns empty string for null/empty input.
     */
    private static String maskCredential(String credential) {
        if (credential == null || credential.isEmpty()) {
            return "";
        }
        if (credential.length() <= 8) {
            return "****";
        }
        return credential.substring(0, 4) + "****" + credential.substring(credential.length() - 4);
    }

    /**
     * Get the alwaysThinkingEnabled setting.
     */
    public Boolean getAlwaysThinkingEnabled() throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        if (!claudeSettings.has("alwaysThinkingEnabled") || claudeSettings.get("alwaysThinkingEnabled").isJsonNull()) {
            return null;
        }
        try {
            return claudeSettings.get("alwaysThinkingEnabled").getAsBoolean();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Set the alwaysThinkingEnabled setting.
     */
    public void setAlwaysThinkingEnabled(boolean enabled) throws IOException {
        updateClaudeSettings(settings -> {
            settings.addProperty("alwaysThinkingEnabled", enabled);
            return true;
        });
    }

    /**
     * Apply provider configuration to Claude settings.json.
     * <p>
     * Aligned with vscode-cc-gui {@code planClaudeSettingsSync}:
     * <ul>
     *   <li>Skip when active provider has no env payload (prevents wiping credentials)</li>
     *   <li>Merge env at key level: only clear plugin-managed keys, keep user/custom env</li>
     *   <li>Preserve system-protected fields (mcpServers, plugins, …)</li>
     * </ul>
     */
    public void applyProviderToClaudeSettings(JsonObject provider) throws IOException {
        applyProviderToClaudeSettings(provider, id -> null);
    }

    /**
     * @param provider       the provider to apply
     * @param providerLookup finds a saved provider by id (null when unknown); used to remove the
     *                       env values the provider recorded in {@code codemossProviderId} wrote
     */
    public void applyProviderToClaudeSettings(JsonObject provider, Function<String, JsonObject> providerLookup)
            throws IOException {
        if (provider == null) {
            throw new IllegalArgumentException("Provider cannot be null");
        }

        // Re-planned against the freshest settings on every retry, so a
        // concurrent provider sync in another window is merged rather than
        // clobbered by a decision computed from an old read.
        mutateClaudeSettings(current -> {
            JsonObject previousProvider = lookupWriter(current, providerLookup);
            ClaudeSettingsSyncPlan.Decision decision = ClaudeSettingsSyncPlan.plan(current, provider, previousProvider);
            if (decision.action == ClaudeSettingsSyncPlan.Action.SKIP) {
                LOG.info("[ClaudeSettingsManager] Skip settings.json sync: " + decision.reason
                        + (provider.has("id") && !provider.get("id").isJsonNull()
                        ? " (active=" + provider.get("id").getAsString() + ")"
                        : ""));
                return null;
            }
            LOG.info("[ClaudeSettingsManager] Applying provider config (managed-env merge, empty-env protected)");
            LOG.info("[ClaudeSettingsManager] Original settings keys: " + current.keySet());
            LOG.info("[ClaudeSettingsManager] Final settings keys: " + decision.nextSettings.keySet());
            return decision.nextSettings;
        });
    }

    private static JsonObject lookupWriter(JsonObject settings, Function<String, JsonObject> providerLookup) {
        if (providerLookup == null || !settings.has("codemossProviderId")
                || !settings.get("codemossProviderId").isJsonPrimitive()) {
            return null;
        }
        return providerLookup.apply(settings.get("codemossProviderId").getAsString());
    }

    /**
     * Sync Skills to Claude settings.json.
     */
    public void syncSkillsToClaudeSettings(JsonArray plugins) throws IOException {
        updateClaudeSettings(settings -> {
            settings.add("plugins", plugins);
            return true;
        });
    }

    /**
     * Repair missing provider-managed fields in Claude settings.json.
     *
     * <p>This is a startup-time "fill in the blanks" pass: it only ADDS fields
     * that are missing from {@code ~/.claude/settings.json}, and never
     * overwrites an existing value. As a result, any manual edits the user
     * made to managed fields (e.g. {@code model}, env vars) are preserved.
     *
     * <p>Used by {@code ChatWindowDelegate.syncActiveProvider()} instead of
     * {@link #applyProviderToClaudeSettings(JsonObject)} (which is a full
     * overwrite and is still used for explicit user actions like switching or
     * editing providers).
     *
     * @param provider the active provider configuration
     * @return true if any field was added or any missing env key was added; false if no changes
     * @throws IOException if reading or writing settings.json fails
     */
    public boolean repairMissingProviderFields(JsonObject provider) throws IOException {
        if (provider == null) {
            throw new IllegalArgumentException("Provider cannot be null");
        }
        if (!provider.has("settingsConfig") || provider.get("settingsConfig").isJsonNull()) {
            // Older configs may predate settingsConfig — treat as nothing to
            // repair rather than spamming a startup exception on every window open.
            LOG.warn("[ClaudeSettingsManager] Provider is missing settingsConfig, nothing to repair");
            return false;
        }

        JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");

        // The repair is re-applied to the freshest settings on every conflict
        // retry, so a concurrent write cannot be silently reverted by a plan
        // computed from an older read.
        AtomicBoolean changed = new AtomicBoolean(false);
        mutateClaudeSettings(current -> {
            boolean mutated = repairIntoSettings(current, settingsConfig, provider);
            changed.set(mutated);
            return mutated ? current : null;
        });

        if (changed.get()) {
            LOG.info("[ClaudeSettingsManager] Repaired settings.json with missing provider fields");
        } else {
            LOG.info("[ClaudeSettingsManager] No missing provider fields to repair");
        }
        return changed.get();
    }

    /**
     * Fill in the provider-managed fields that settings.json is missing.
     *
     * @param claudeSettings the settings to repair (modified in place)
     * @param settingsConfig the provider's settings payload
     * @param provider       the provider entry (for its id)
     * @return true when at least one field or env key was added
     */
    private boolean repairIntoSettings(JsonObject claudeSettings, JsonObject settingsConfig, JsonObject provider) {
        boolean changed = false;

        // 1. Repair top-level provider-managed fields.
        for (String key : settingsConfig.keySet()) {
            JsonElement value = settingsConfig.get(key);
            if (value == null || value.isJsonNull()) {
                continue;
            }
            if (PROTECTED_SYSTEM_FIELDS.contains(key)) {
                continue;
            }
            if (!PROVIDER_MANAGED_FIELDS.contains(key)) {
                continue;
            }
            if (claudeSettings.has(key)) {
                LOG.debug("[ClaudeSettingsManager] Preserving existing field: " + key);
                continue;
            }
            claudeSettings.add(key, value);
            LOG.info("[ClaudeSettingsManager] Repaired missing field: " + key);
            changed = true;
        }

        // 2. For the special "env" object, also fill in individual env keys that
        //    are missing. We never touch keys that already exist in the global env.
        if (settingsConfig.has("env") && settingsConfig.get("env").isJsonObject()
                && claudeSettings.has("env") && claudeSettings.get("env").isJsonObject()) {
            JsonObject providerEnv = settingsConfig.getAsJsonObject("env");
            JsonObject globalEnv = claudeSettings.getAsJsonObject("env");
            for (String envKey : providerEnv.keySet()) {
                if (globalEnv.has(envKey)) {
                    continue; // never overwrite an existing env key
                }
                JsonElement envValue = providerEnv.get(envKey);
                if (envValue == null || envValue.isJsonNull()) {
                    continue;
                }
                globalEnv.add(envKey, envValue);
                LOG.info("[ClaudeSettingsManager] Repaired missing env key: " + envKey);
                changed = true;
            }
        }

        // 3. Only set codemossProviderId when there is no existing one (e.g. first
        //    install) — switching providers must keep using the explicit switch path.
        if (provider.has("id") && !provider.get("id").isJsonNull()) {
            String providerId = provider.get("id").getAsString();
            if (!claudeSettings.has("codemossProviderId")
                    || claudeSettings.get("codemossProviderId").isJsonNull()) {
                claudeSettings.addProperty("codemossProviderId", providerId);
                changed = true;
            }
        }
        return changed;
    }
}
