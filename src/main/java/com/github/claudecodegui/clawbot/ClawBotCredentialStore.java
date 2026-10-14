package com.github.claudecodegui.clawbot;

import com.intellij.credentialStore.CredentialAttributes;
import com.intellij.credentialStore.CredentialAttributesKt;
import com.intellij.credentialStore.CredentialStore;
import com.intellij.credentialStore.Credentials;
import com.intellij.ide.passwordSafe.PasswordSafe;

import java.util.Objects;
import java.util.Optional;

/** Stores the active iLink bot token outside ordinary plugin configuration. */
public final class ClawBotCredentialStore {

    static final String SERVICE_NAME = "CC GUI Claw Bot iLink";
    static final String DEFAULT_BINDING_KEY = "default";
    private static final int MAX_TOKEN_LENGTH = 16 * 1024;

    private final SecretBackend backend;

    public ClawBotCredentialStore() {
        this(new PasswordSafeBackend());
    }

    ClawBotCredentialStore(SecretBackend backend) {
        this.backend = Objects.requireNonNull(backend, "backend");
    }

    public void saveBotToken(String botToken) {
        requireToken(botToken);
        backend.write(DEFAULT_BINDING_KEY, botToken);
    }

    public Optional<String> loadBotToken() {
        String token = backend.read(DEFAULT_BINDING_KEY);
        return token == null || token.isEmpty() ? Optional.empty() : Optional.of(token);
    }

    public void clearBotToken() {
        backend.clear(DEFAULT_BINDING_KEY);
    }

    private static void requireToken(String botToken) {
        if (botToken == null || botToken.isEmpty() || botToken.length() > MAX_TOKEN_LENGTH
                || botToken.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid Claw Bot credential");
        }
    }

    interface SecretBackend {

        String read(String key);

        void write(String key, String value);

        void clear(String key);
    }

    static final class PasswordSafeBackend implements SecretBackend {

        private static final Object STORE_LOCK = new Object();
        private final CredentialStore passwordSafe;

        PasswordSafeBackend() {
            this(PasswordSafe.getInstance());
        }

        PasswordSafeBackend(CredentialStore passwordSafe) {
            this.passwordSafe = Objects.requireNonNull(passwordSafe, "passwordSafe");
        }

        @Override
        public String read(String key) {
            synchronized (STORE_LOCK) {
                String value = passwordSafe.getPassword(attributes(key));
                if (value != null) {
                    return value;
                }
                Credentials legacy = legacyCredentials(key);
                if (legacy == null) {
                    return null;
                }
                value = legacy.getPasswordAsString();
                if (value != null) {
                    passwordSafe.set(attributes(key), new Credentials(key, value));
                    clearLegacy(key);
                }
                return value;
            }
        }

        @Override
        public void write(String key, String value) {
            synchronized (STORE_LOCK) {
                passwordSafe.set(attributes(key), new Credentials(key, value));
                clearLegacy(key);
            }
        }

        @Override
        public void clear(String key) {
            synchronized (STORE_LOCK) {
                passwordSafe.set(attributes(key), null);
                clearLegacy(key);
            }
        }

        private Credentials legacyCredentials(String key) {
            Credentials legacy = passwordSafe.get(new CredentialAttributes(SERVICE_NAME, key));
            return legacy != null && key.equals(legacy.getUserName()) ? legacy : null;
        }

        private void clearLegacy(String key) {
            if (legacyCredentials(key) != null) {
                passwordSafe.set(new CredentialAttributes(SERVICE_NAME, key), null);
            }
        }

        private static CredentialAttributes attributes(String key) {
            return new CredentialAttributes(CredentialAttributesKt.generateServiceName(SERVICE_NAME, key), key);
        }
    }
}
