package com.github.claudecodegui.clawbot;

import java.net.URI;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/** Accepts a pairing result and exposes only non-sensitive binding state. */
public final class ClawBotBindingHandoff {

    private static final String DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
    private static final Pattern TRUSTED_HOST = Pattern.compile(
            "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*weixin\\.qq\\.com$",
            Pattern.CASE_INSENSITIVE);
    private static final int MAX_ID_LENGTH = 512;

    private final ClawBotCredentialStore credentialStore;
    private final ClawBotBindingMetadataStore metadataStore;
    private BindingSnapshot snapshot = new BindingSnapshot("UNBOUND", null, 0L, "NONE");

    public ClawBotBindingHandoff() {
        this(new ClawBotCredentialStore(), new ClawBotBindingMetadataStore());
    }

    ClawBotBindingHandoff(
            ClawBotCredentialStore credentialStore, ClawBotBindingMetadataStore metadataStore) {
        this.credentialStore = Objects.requireNonNull(credentialStore, "credentialStore");
        this.metadataStore = Objects.requireNonNull(metadataStore, "metadataStore");
    }

    public synchronized BindingSnapshot accept(
        String botId, String baseUrl, String userId, String botToken) {
        requireOpaqueValue(botId, "botId");
        requireOptionalOpaqueValue(userId, "userId");
        String normalizedBaseUrl = normalizeBaseUrl(baseUrl);
        long revision = snapshot.revision() + 1L;
        credentialStore.saveBotToken(botToken);
        try {
            metadataStore.save(new ClawBotBindingMetadataStore.BindingMetadata(
                    "BOUND", normalizedBaseUrl, revision));
        } catch (RuntimeException error) {
            credentialStore.clearBotToken();
            throw error;
        }
        snapshot = new BindingSnapshot("BOUND", normalizedBaseUrl, revision, "NONE");
        return snapshot;
    }

    public synchronized BindingSnapshot status() {
        ClawBotBindingMetadataStore.ReadResult metadata;
        try {
            metadata = metadataStore.readState();
        } catch (RuntimeException error) {
            snapshot = new BindingSnapshot("UNKNOWN", null, snapshot.revision(), "BINDING_METADATA_UNAVAILABLE");
            return snapshot;
        }
        Optional<String> token;
        try {
            token = credentialStore.loadBotToken();
        } catch (RuntimeException error) {
            long revision = metadata.metadata() == null ? snapshot.revision() : metadata.metadata().revision();
            snapshot = new BindingSnapshot("UNKNOWN", null, revision, "PASSWORD_SAFE_UNAVAILABLE");
            return snapshot;
        }
        snapshot = reconcilePersistedState(metadata, token.isPresent(), snapshot.revision());
        return snapshot;
    }

    synchronized Optional<RuntimeCredentials> runtimeCredentials() {
        BindingSnapshot binding = status();
        if (!"BOUND".equals(binding.state())) {
            return Optional.empty();
        }
        return credentialStore.loadBotToken()
                .map(token -> new RuntimeCredentials(binding.baseUrl(), token));
    }

    public synchronized BindingSnapshot clear() {
        credentialStore.clearBotToken();
        long revision = snapshot.revision() + 1L;
        metadataStore.save(new ClawBotBindingMetadataStore.BindingMetadata("UNBOUND", null, revision));
        snapshot = new BindingSnapshot("UNBOUND", null, revision, "NONE");
        return snapshot;
    }

    private static BindingSnapshot reconcilePersistedState(
            ClawBotBindingMetadataStore.ReadResult metadata, boolean tokenPresent, long previousRevision) {
        if (!metadata.valid()) {
            return new BindingSnapshot("UNKNOWN", null, previousRevision, "BINDING_METADATA_INVALID");
        }
        ClawBotBindingMetadataStore.BindingMetadata binding = metadata.metadata();
        if (!metadata.present()) {
            return tokenPresent
                    ? new BindingSnapshot("BOUND", DEFAULT_BASE_URL, previousRevision, "LEGACY_METADATA_MISSING")
                    : new BindingSnapshot("UNBOUND", null, previousRevision, "NONE");
        }
        if (binding == null) {
            return new BindingSnapshot("UNKNOWN", null, previousRevision, "BINDING_METADATA_INVALID");
        }
        if ("BOUND".equals(binding.state()) && tokenPresent) {
            try {
                return new BindingSnapshot("BOUND", normalizeBaseUrl(binding.baseUrl()), binding.revision(), "NONE");
            } catch (IllegalArgumentException ignored) {
                return new BindingSnapshot("UNKNOWN", null, binding.revision(), "BINDING_METADATA_INVALID");
            }
        }
        if ("BOUND".equals(binding.state())) {
            return new BindingSnapshot("UNKNOWN", null, binding.revision(), "BOUND_TOKEN_MISSING");
        }
        if (!tokenPresent) {
            return new BindingSnapshot("UNBOUND", null, binding.revision(), "NONE");
        }
        return new BindingSnapshot("UNKNOWN", null, binding.revision(), "UNBOUND_TOKEN_PRESENT");
    }

    private static String normalizeBaseUrl(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("iLink base URL is required");
        }
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))
                    || (uri.getPort() != -1 && uri.getPort() != 443)
                    || !TRUSTED_HOST.matcher(host).matches()) {
                throw new IllegalArgumentException("iLink base URL is not approved");
            }
            return "https://" + host.toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("iLink base URL is not approved", error);
        }
    }

    private static void requireOpaqueValue(String value, String name) {
        if (value == null || value.isBlank() || value.length() > MAX_ID_LENGTH
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid Claw Bot " + name);
        }
    }

    private static void requireOptionalOpaqueValue(String value, String name) {
        if (value != null && !value.isBlank()) {
            requireOpaqueValue(value, name);
        }
    }

    public record BindingSnapshot(String state, String baseUrl, long revision, String diagnostic) {

        public BindingSnapshot {
            Objects.requireNonNull(state, "state");
            Objects.requireNonNull(diagnostic, "diagnostic");
            if (revision < 0L) {
                throw new IllegalArgumentException("revision must not be negative");
            }
            if ("BOUND".equals(state) && (baseUrl == null || baseUrl.isBlank())) {
                throw new IllegalArgumentException("BOUND state requires a base URL");
            }
            if (!"BOUND".equals(state) && baseUrl != null) {
                throw new IllegalArgumentException("Only BOUND state may have a base URL");
            }
        }

        public BindingSnapshot(String state, String baseUrl, long revision) {
            this(state, baseUrl, revision, "NONE");
        }
    }

    static final class RuntimeCredentials {

        private final String baseUrl;
        private final String botToken;

        private RuntimeCredentials(String baseUrl, String botToken) {
            this.baseUrl = baseUrl;
            this.botToken = botToken;
        }

        String baseUrl() {
            return baseUrl;
        }

        String botToken() {
            return botToken;
        }

        @Override
        public String toString() {
            return "RuntimeCredentials{baseUrl='" + baseUrl + "'}";
        }
    }
}
