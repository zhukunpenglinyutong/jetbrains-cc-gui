package com.github.claudecodegui.settings;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Codex Provider Manager
 * Manages Codex provider configurations stored in ~/.codemoss/config.json
 * and applies active provider to ~/.codex/ files
 */
public class CodexProviderManager {
    private static final Logger LOG = Logger.getInstance(CodexProviderManager.class);
    private static final String APPLIED_PROVIDER_ID_KEY = "appliedProviderId";
    private static final String APPLIED_PROVIDER_REVISION_KEY = "appliedProviderRevision";
    private static final Object PROVIDER_STATE_LOCK = new Object();
    public static final String CODEX_CLI_LOGIN_PROVIDER_ID = "__codex_cli_login__";

    private final Function<Void, JsonObject> configReader;
    private final Consumer<JsonObject> configWriter;
    private final ConfigPathManager pathManager;
    private final CodexSettingsManager codexSettingsManager;

    public CodexProviderManager(
            Function<Void, JsonObject> configReader,
            Consumer<JsonObject> configWriter,
            ConfigPathManager pathManager,
            CodexSettingsManager codexSettingsManager) {
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.pathManager = pathManager;
        this.codexSettingsManager = codexSettingsManager;
    }

    /**
     * Get all Codex providers
     */
    public List<JsonObject> getCodexProviders() {
        JsonObject config = configReader.apply(null);
        List<JsonObject> result = new ArrayList<>();

        String currentId = null;
        if (config.has("codex") && config.get("codex").isJsonObject()) {
            JsonObject codex = config.getAsJsonObject("codex");
            if (codex.has("current") && !codex.get("current").isJsonNull()) {
                currentId = codex.get("current").getAsString();
            }
        }
        boolean cliLoginAuthorized = isCodexCliLoginAuthorized(config);

        // Add CLI Login virtual provider at the top
        result.add(createCodexCliLoginProviderObject(
                CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId) && cliLoginAuthorized));

        if (!config.has("codex")) {
            return result;
        }

        JsonObject codex = config.getAsJsonObject("codex");
        if (!codex.has("providers")) {
            return result;
        }

        JsonObject providers = codex.getAsJsonObject("providers");

        // Get provider order from config, or use default order (by key)
        List<String> orderedIds = ProviderOrderHelper.getProviderOrder(codex, providers.keySet());

        // Add providers in order
        for (String id : orderedIds) {
            if (providers.has(id)) {
                JsonObject provider = providers.getAsJsonObject(id).deepCopy();
                // Ensure id field exists
                if (!provider.has("id")) {
                    provider.addProperty("id", id);
                }
                stripLegacyCredentialMarkers(provider);
                // Add isActive flag
                provider.addProperty("isActive", id.equals(currentId));
                result.add(provider);
            }
        }

        return result;
    }

    /**
     * Save provider order.
     */
    public void saveProviderOrder(List<String> orderedIds) throws IOException {
        synchronized (PROVIDER_STATE_LOCK) {
            saveProviderOrderLocked(orderedIds);
        }
    }

    private void saveProviderOrderLocked(List<String> orderedIds) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("codex")) {
            JsonObject codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        JsonObject codex = config.getAsJsonObject("codex");
        ProviderOrderHelper.setProviderOrder(codex, orderedIds);

        writeConfig(config);
        LOG.info("[CodexProviderManager] Saved provider order: " + orderedIds);
    }

    /**
     * Get currently active Codex provider
     */
    public JsonObject getActiveCodexProvider() {
        JsonObject config = configReader.apply(null);

        if (!config.has("codex")) {
            return null;
        }

        JsonObject codex = config.getAsJsonObject("codex");
        if (!codex.has("current")) {
            return null;
        }

        String currentId = codex.get("current").getAsString();
        if (currentId == null || currentId.isEmpty()) {
            return null;
        }

        // Handle CLI Login virtual provider
        if (CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId)) {
            if (!isCodexCliLoginAuthorized(config)) {
                return null;
            }
            return createCodexCliLoginProviderObject(true);
        }

        if (!codex.has("providers")) {
            return null;
        }

        JsonObject providers = codex.getAsJsonObject("providers");

        if (providers.has(currentId)) {
            JsonObject provider = providers.getAsJsonObject(currentId).deepCopy();
            if (!provider.has("id")) {
                provider.addProperty("id", currentId);
            }
            stripLegacyCredentialMarkers(provider);
            provider.addProperty("isActive", true);
            return provider;
        }

        return null;
    }

    /**
     * Add a new Codex provider
     */
    public void addCodexProvider(JsonObject provider) throws IOException {
        synchronized (PROVIDER_STATE_LOCK) {
            addCodexProviderLocked(provider);
        }
    }

    private void addCodexProviderLocked(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }
        JsonObject providerToPersist = provider.deepCopy();

        JsonObject config = configReader.apply(null);

        // Ensure codex configuration exists
        if (!config.has("codex")) {
            JsonObject codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        JsonObject codex = config.getAsJsonObject("codex");
        JsonObject providers = codex.getAsJsonObject("providers");

        String id = providerToPersist.get("id").getAsString();

        // Check if ID already exists
        if (providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' already exists");
        }

        // Add creation timestamp
        if (!providerToPersist.has("createdAt")) {
            providerToPersist.addProperty("createdAt", System.currentTimeMillis());
        }

        stripLegacyCredentialMarkers(providerToPersist);
        providers.add(id, providerToPersist);
        writeConfig(config);
        LOG.info("[CodexProviderManager] Added provider: " + id);
    }

    /**
     * Save provider (update if exists, add if not)
     */
    public void saveCodexProvider(JsonObject provider) throws IOException {
        synchronized (PROVIDER_STATE_LOCK) {
            saveCodexProviderLocked(provider);
        }
    }

    private void saveCodexProviderLocked(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }
        JsonObject savedProvider = provider.deepCopy();

        JsonObject config = configReader.apply(null);

        // Ensure codex configuration exists
        if (!config.has("codex")) {
            JsonObject codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        JsonObject codex = config.getAsJsonObject("codex");
        JsonObject providers = codex.getAsJsonObject("providers");

        String id = savedProvider.get("id").getAsString();
        JsonObject existingProvider = providers.has(id) ? providers.getAsJsonObject(id).deepCopy() : null;
        JsonObject previousProvider = existingProvider == null ? null : providerWithId(existingProvider, id);

        // Preserve createdAt if updating existing provider
        if (existingProvider != null) {
            if (existingProvider.has("createdAt") && !savedProvider.has("createdAt")) {
                savedProvider.addProperty("createdAt", existingProvider.get("createdAt").getAsLong());
            }
        } else {
            if (!savedProvider.has("createdAt")) {
                savedProvider.addProperty("createdAt", System.currentTimeMillis());
            }
        }

        stripLegacyCredentialMarkers(savedProvider);
        JsonObject providerToApply = providerWithId(savedProvider, id);
        boolean activeSettingsChanged = id.equals(getCurrentId(codex))
                && managedSettingsChanged(previousProvider, providerToApply);
        if (activeSettingsChanged) {
            codexSettingsManager.transitionProvider(previousProvider, providerToApply, false, () -> {
                providers.add(id, savedProvider);
                commitManagedProviderState(codex, id, providerToApply);
                writeConfig(config);
            });
        } else {
            providers.add(id, savedProvider);
            writeConfig(config);
        }
    }

    /**
     * Update an existing Codex provider
     */
    public void updateCodexProvider(String id, JsonObject updates) throws IOException {
        synchronized (PROVIDER_STATE_LOCK) {
            updateCodexProviderLocked(id, updates);
        }
    }

    private void updateCodexProviderLocked(String id, JsonObject updates) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("codex")) {
            throw new IllegalArgumentException("No codex configuration found");
        }

        JsonObject codex = config.getAsJsonObject("codex");
        JsonObject providers = codex.getAsJsonObject("providers");

        if (!providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' not found");
        }

        JsonObject persistedProvider = providers.getAsJsonObject(id).deepCopy();
        JsonObject previousProvider = providerWithId(persistedProvider, id);
        JsonObject updatedProvider = persistedProvider.deepCopy();

        // Merge updates
        for (String key : updates.keySet()) {
            // Don't allow modifying id
            if (key.equals("id")) {
                continue;
            }

            // If value is null (JsonNull), remove the field
            if (updates.get(key).isJsonNull()) {
                updatedProvider.remove(key);
            } else {
                updatedProvider.add(key, updates.get(key));
            }
        }

        stripLegacyCredentialMarkers(updatedProvider);
        JsonObject providerToApply = providerWithId(updatedProvider, id);
        boolean activeSettingsChanged = id.equals(getCurrentId(codex))
                && managedSettingsChanged(previousProvider, providerToApply);
        if (activeSettingsChanged) {
            codexSettingsManager.transitionProvider(previousProvider, providerToApply, false, () -> {
                providers.add(id, updatedProvider);
                commitManagedProviderState(codex, id, providerToApply);
                writeConfig(config);
            });
        } else {
            providers.add(id, updatedProvider);
            writeConfig(config);
        }
        LOG.info("[CodexProviderManager] Updated provider: " + id);
    }

    /**
     * Delete a Codex provider
     * @param id Provider ID
     * @return DeleteResult with operation status and error details
     */
    public DeleteResult deleteCodexProvider(String id) {
        synchronized (PROVIDER_STATE_LOCK) {
            return deleteCodexProviderLocked(id);
        }
    }

    private DeleteResult deleteCodexProviderLocked(String id) {
        Path configFilePath = pathManager.getConfigFilePath();
        try {
            JsonObject config = configReader.apply(null);
            if (!config.has("codex")) {
                return DeleteResult.failure(
                    DeleteResult.ErrorType.FILE_NOT_FOUND,
                    "No codex configuration found",
                    configFilePath.toString(),
                    "Please add at least one Codex provider first"
                );
            }

            JsonObject codex = config.getAsJsonObject("codex");
            JsonObject providers = codex.getAsJsonObject("providers");
            if (!providers.has(id)) {
                return DeleteResult.failure(
                    DeleteResult.ErrorType.FILE_NOT_FOUND,
                    "Provider with id '" + id + "' not found",
                    null,
                    "Please check if the provider ID is correct"
                );
            }

            JsonObject deletedProvider = providerWithId(providers.getAsJsonObject(id), id);
            boolean active = id.equals(getCurrentId(codex));
            providers.remove(id);
            ProviderOrderHelper.removeFromOrder(codex, id);

            if (active) {
                String fallbackId = providers.size() > 0 ? providers.keySet().iterator().next() : "";
                JsonObject fallbackProvider = fallbackId.isEmpty()
                        ? null
                        : providerWithId(providers.getAsJsonObject(fallbackId), fallbackId);
                codexSettingsManager.transitionProvider(deletedProvider, fallbackProvider, false, () -> {
                    if (fallbackProvider == null) {
                        clearAppliedProviderState(codex);
                        codex.addProperty("current", "");
                    } else {
                        commitManagedProviderState(codex, fallbackId, fallbackProvider);
                    }
                    writeConfig(config);
                });
            } else {
                writeConfig(config);
            }
            LOG.info("[CodexProviderManager] Deleted provider: " + id);
            return DeleteResult.success(id);
        } catch (Exception e) {
            return DeleteResult.fromException(e, configFilePath.toString());
        }
    }

    /**
     * Switch to a different Codex provider
     */
    public void switchCodexProvider(String id) throws IOException {
        switchCodexProvider(id, false);
    }

    public void switchToCodexCliLogin() throws IOException {
        switchCodexProvider(CODEX_CLI_LOGIN_PROVIDER_ID, true);
    }

    public void setLocalConfigAuthorized(boolean authorized) throws IOException {
        synchronized (PROVIDER_STATE_LOCK) {
            codexSettingsManager.runWithConfigAccess(() -> true, () -> {
                JsonObject config = configReader.apply(null);
                JsonObject codex;
                if (config.has("codex") && config.get("codex").isJsonObject()) {
                    codex = config.getAsJsonObject("codex");
                } else {
                    codex = new JsonObject();
                    codex.add("providers", new JsonObject());
                    codex.addProperty("current", "");
                    config.add("codex", codex);
                }
                codex.addProperty("localConfigAuthorized", authorized);
                writeConfig(config);
            });
        }
    }

    private void switchCodexProvider(String id, boolean authorizeCliLogin) throws IOException {
        synchronized (PROVIDER_STATE_LOCK) {
            switchCodexProviderLocked(id, authorizeCliLogin);
        }
    }

    private void switchCodexProviderLocked(String id, boolean authorizeCliLogin) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("codex")) {
            JsonObject codexSection = new JsonObject();
            codexSection.add("providers", new JsonObject());
            codexSection.addProperty("current", "");
            config.add("codex", codexSection);
        }

        JsonObject codex = config.getAsJsonObject("codex");
        JsonObject providers = codex.has("providers") && codex.get("providers").isJsonObject()
                ? codex.getAsJsonObject("providers")
                : new JsonObject();
        codex.add("providers", providers);
        String nextId = id == null ? "" : id.trim();
        boolean useCliLogin = CODEX_CLI_LOGIN_PROVIDER_ID.equals(nextId);

        // CLI Login is a virtual provider — no need to check providers map
        if (!nextId.isEmpty() && !useCliLogin && !providers.has(nextId)) {
            throw new IllegalArgumentException("Provider with id '" + nextId + "' not found");
        }

        String previousId = getCurrentId(codex);
        JsonObject previousProvider = providers.has(previousId)
                ? providerWithId(providers.getAsJsonObject(previousId), previousId)
                : null;
        JsonObject nextProvider = !nextId.isEmpty() && !useCliLogin
                ? providerWithId(providers.getAsJsonObject(nextId), nextId)
                : null;

        codexSettingsManager.transitionProvider(previousProvider, nextProvider, useCliLogin, () -> {
            if (useCliLogin) {
                clearAppliedProviderState(codex);
                if (authorizeCliLogin) {
                    codex.addProperty("localConfigAuthorized", true);
                }
                codex.addProperty("current", CODEX_CLI_LOGIN_PROVIDER_ID);
            } else if (nextProvider != null) {
                commitManagedProviderState(codex, nextId, nextProvider);
            } else {
                clearAppliedProviderState(codex);
                codex.addProperty("current", "");
            }
            writeConfig(config);
        });
        LOG.info("[CodexProviderManager] Switched to provider: " + (nextId.isEmpty() ? "none" : nextId));
    }

    /**
     * Batch save providers
     * @param providers List of providers to save
     * @return Number of successfully saved providers
     */
    public int saveProviders(List<JsonObject> providers) throws IOException {
        int count = 0;
        for (JsonObject provider : providers) {
            try {
                saveCodexProvider(provider);
                count++;
            } catch (Exception e) {
                LOG.warn("Failed to save provider " + provider.get("id") + ": " + e.getMessage());
            }
        }
        return count;
    }

    /**
     * Get current Codex CLI configuration (from ~/.codex/)
     */
    public JsonObject getCurrentCodexConfig() throws IOException {
        return codexSettingsManager.getCurrentCodexConfig();
    }

    /**
     * A managed provider is ready only after its exact saved revision reached ~/.codex.
     * Legacy installations without markers are accepted only after file-content verification.
     */
    public boolean isManagedProviderReady() throws IOException {
        if (codexSettingsManager.isConfigLockHeldByCurrentThread()) {
            return isManagedProviderReadyInternal(false);
        }
        synchronized (PROVIDER_STATE_LOCK) {
            boolean[] ready = new boolean[1];
            codexSettingsManager.runWithConfigAccess(
                    () -> true,
                    () -> ready[0] = isManagedProviderReadyInternal(true));
            return ready[0];
        }
    }

    private boolean isManagedProviderReadyInternal(boolean migrateState) throws IOException {
        JsonObject config = configReader.apply(null);
        if (!config.has("codex") || !config.get("codex").isJsonObject()) {
            return false;
        }
        JsonObject codex = config.getAsJsonObject("codex");
        String currentId = getCurrentId(codex);
        if (currentId.isEmpty() || CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId)
                || !codex.has("providers") || !codex.get("providers").isJsonObject()
                || !codex.getAsJsonObject("providers").has(currentId)) {
            return false;
        }

        JsonObject provider = providerWithId(codex.getAsJsonObject("providers").getAsJsonObject(currentId), currentId);
        boolean applied = codexSettingsManager.isProviderApplied(provider);
        if (codex.has(APPLIED_PROVIDER_ID_KEY) && codex.has(APPLIED_PROVIDER_REVISION_KEY)) {
            return currentId.equals(codex.get(APPLIED_PROVIDER_ID_KEY).getAsString())
                    && providerRevision(provider).equals(codex.get(APPLIED_PROVIDER_REVISION_KEY).getAsString())
                    && applied;
        }
        if (applied && migrateState) {
            commitManagedProviderState(codex, currentId, provider);
            writeConfig(config);
        }
        return applied;
    }

    private void commitManagedProviderState(JsonObject codex, String providerId, JsonObject provider) {
        codex.addProperty(APPLIED_PROVIDER_ID_KEY, providerId);
        codex.addProperty(APPLIED_PROVIDER_REVISION_KEY, providerRevision(provider));
        codex.addProperty("current", providerId);
    }

    private void clearAppliedProviderState(JsonObject codex) {
        codex.remove(APPLIED_PROVIDER_ID_KEY);
        codex.remove(APPLIED_PROVIDER_REVISION_KEY);
    }

    private String getCurrentId(JsonObject codex) {
        return codex.has("current") && !codex.get("current").isJsonNull()
                ? codex.get("current").getAsString().trim()
                : "";
    }

    private JsonObject providerWithId(JsonObject provider, String id) {
        JsonObject copy = provider.deepCopy();
        copy.addProperty("id", id);
        stripLegacyCredentialMarkers(copy);
        return copy;
    }

    private boolean managedSettingsChanged(JsonObject previousProvider, JsonObject nextProvider) {
        if (previousProvider == null || nextProvider == null) {
            return previousProvider != nextProvider;
        }
        return !providerValue(previousProvider, "configToml").equals(providerValue(nextProvider, "configToml"))
                || !providerValue(previousProvider, "authJson").equals(providerValue(nextProvider, "authJson"));
    }

    private String providerValue(JsonObject provider, String key) {
        return provider.has(key) && provider.get(key).isJsonPrimitive()
                ? provider.get(key).getAsString()
                : "";
    }

    private String providerRevision(JsonObject provider) {
        String configToml = provider.has("configToml") && provider.get("configToml").isJsonPrimitive()
                ? provider.get("configToml").getAsString()
                : "";
        String authJson = provider.has("authJson") && provider.get("authJson").isJsonPrimitive()
                ? provider.get("authJson").getAsString()
                : "";
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(configToml.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(authJson.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private void writeConfig(JsonObject config) throws IOException {
        try {
            configWriter.accept(config);
        } catch (RuntimeException e) {
            if (e.getCause() instanceof IOException) {
                throw (IOException) e.getCause();
            }
            throw new IOException("Failed to save Codex provider state", e);
        }
    }

    /**
     * Create virtual CLI Login provider object.
     * Unlike regular providers, this is not stored in config but generated dynamically.
     */
    private JsonObject createCodexCliLoginProviderObject(boolean isActive) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", CODEX_CLI_LOGIN_PROVIDER_ID);
        provider.addProperty("name", ClaudeCodeGuiBundle.message("provider.codexCliLogin.name"));
        provider.addProperty("isActive", isActive);
        provider.addProperty("isCodexCliLoginProvider", true);
        return provider;
    }

    /**
     * Dev builds briefly stored provider auth in the OS keychain and left
     * "authStoredInPasswordSafe" / "credentialUnavailable" markers in the config.
     * Keychain storage was removed before release; strip those stale markers so
     * leftover dev configs stay readable. authJson now stays inline in the config.
     */
    private static void stripLegacyCredentialMarkers(JsonObject provider) {
        if (provider == null) {
            return;
        }
        provider.remove("authStoredInPasswordSafe");
        provider.remove("credentialUnavailable");
    }

    /**
     * Check if the current active provider is Codex CLI Login.
     */
    public boolean isCodexCliLoginProviderActive() {
        try {
            JsonObject config = configReader.apply(null);
            if (!config.has("codex")) { return false; }
            JsonObject codex = config.getAsJsonObject("codex");
            if (!codex.has("current")) { return false; }
            return CODEX_CLI_LOGIN_PROVIDER_ID.equals(codex.get("current").getAsString())
                    && isCodexCliLoginAuthorized(config);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isCodexCliLoginAuthorized(JsonObject config) {
        if (config == null || !config.has("codex") || !config.get("codex").isJsonObject()) {
            return false;
        }
        JsonObject codex = config.getAsJsonObject("codex");
        return codex.has("localConfigAuthorized")
                && !codex.get("localConfigAuthorized").isJsonNull()
                && codex.get("localConfigAuthorized").getAsBoolean();
    }
}
