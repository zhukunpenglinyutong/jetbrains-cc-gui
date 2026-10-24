package com.github.claudecodegui.clawbot;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonParser;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Durable lifecycle messages encrypted with a domain-separated key from the active binding. */
final class ClawBotPendingDeliveryStore {
    private static final int MAX_ENTRIES = 256;
    private static final int MAX_BYTES = 24 * 1024 * 1024;
    private static final byte[] DOMAIN = "CCGUI ClawBot pending delivery v1".getBytes(StandardCharsets.UTF_8);
    private final Path file;
    private final int maxTextLength;
    private final Map<String, Delivery> entries = new LinkedHashMap<>();
    private boolean loaded;

    ClawBotPendingDeliveryStore(Path directory) {
        this(directory, "pending-deliveries.enc");
    }

    ClawBotPendingDeliveryStore(Path directory, String name) {
        this(directory, name, ClawBotInboundMessage.MAX_TEXT_LENGTH);
    }

    ClawBotPendingDeliveryStore(Path directory, String name, int maxTextLength) {
        file = directory.resolve(name);
        this.maxTextLength = maxTextLength;
    }

    synchronized void reload() {
        entries.clear();
        loaded = false;
    }

    synchronized Delivery put(Delivery delivery, String token) throws IOException {
        return putAll(List.of(delivery), token).get(0);
    }

    synchronized List<Delivery> putAll(List<Delivery> deliveries, String token) throws IOException {
        load(token);
        Map<String, Delivery> previous = new LinkedHashMap<>(entries);
        try {
            for (Delivery delivery : deliveries) {
                entries.putIfAbsent(delivery.id(), delivery);
            }
            long active = entries.values().stream().filter(value -> !value.unknown()).count();
            long ordinary = entries.values().stream().filter(value -> !value.unknown() && !value.requireAuthorization()).count();
            if (active > MAX_ENTRIES || ordinary > MAX_ENTRIES - 32) {
                throw new IOException("CLAWBOT_DELIVERY_QUEUE_FULL");
            }
            trimArchived();
            save(token);
            return deliveries.stream().map(value -> entries.get(value.id())).toList();
        } catch (IOException error) {
            entries.clear();
            entries.putAll(previous);
            throw error;
        }
    }

    synchronized void removeRecipient(String recipient, String token) throws IOException {
        load(token);
        Map<String, Delivery> previous = new LinkedHashMap<>(entries);
        entries.values().removeIf(value -> value.recipient().equals(recipient));
        try {
            save(token);
        } catch (IOException error) {
            entries.clear();
            entries.putAll(previous);
            throw error;
        }
    }

    private void trimArchived() {
        long archived = entries.values().stream().filter(Delivery::unknown).count();
        var iterator = entries.values().iterator();
        while (archived > MAX_ENTRIES && iterator.hasNext()) {
            if (iterator.next().unknown()) {
                iterator.remove();
                archived--;
            }
        }
    }

    synchronized List<Delivery> pending(String token) throws IOException {
        load(token);
        return List.copyOf(entries.values());
    }

    synchronized void replace(Delivery delivery, String token) throws IOException {
        load(token);
        Delivery previous = entries.get(delivery.id());
        if (previous == null) {
            throw new IOException("CLAWBOT_REPLY_BODY_UNAVAILABLE");
        }
        entries.put(delivery.id(), delivery);
        try {
            save(token);
        } catch (IOException error) {
            entries.put(delivery.id(), previous);
            throw error;
        }
    }

    synchronized void remove(String id, String token) throws IOException {
        load(token);
        Map<String, Delivery> snapshot = new LinkedHashMap<>(entries);
        Delivery previous = entries.remove(id);
        if (previous != null) {
            try {
                entries.replaceAll((key, value) -> id.equals(value.predecessor())
                        ? new Delivery(value.id(), value.recipient(), value.context(), value.text(), value.requireAuthorization(), null,
                                value.unknown(), value.groupId(), value.recoverySource()) : value);
                save(token);
            } catch (IOException error) {
                entries.clear();
                entries.putAll(snapshot);
                throw error;
            }
        }
    }

    synchronized void clear() throws IOException {
        Files.deleteIfExists(file);
        entries.clear();
        loaded = false;
    }

    synchronized void markUnknown(String id, String token) throws IOException {
        load(token);
        Delivery value = entries.get(id);
        if (value != null && !value.unknown()) {
            Map<String, Delivery> previous = new LinkedHashMap<>(entries);
            entries.replaceAll((key, entry) -> key.equals(id)
                    || (value.groupId() != null && value.groupId().equals(entry.groupId()))
                    ? new Delivery(entry.id(), entry.recipient(), entry.context(), entry.text(),
                            entry.requireAuthorization(), entry.predecessor(), true, entry.groupId(), entry.recoverySource()) : entry);
            try {
                trimArchived();
                save(token);
            } catch (IOException error) {
                entries.clear();
                entries.putAll(previous);
                throw error;
            }
        }
    }

    private void load(String token) throws IOException {
        if (loaded) {
            return;
        }
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) {
                throw new IOException("CLAWBOT_DELIVERY_STORE_INVALID");
            }
            try {
                byte[] encrypted = Files.readAllBytes(file);
                if (encrypted.length < 28) {
                    throw new IllegalArgumentException("Invalid encrypted payload");
                }
                Cipher cipher = cipher(Cipher.DECRYPT_MODE, token, Arrays.copyOf(encrypted, 12));
                byte[] plain = cipher.doFinal(encrypted, 12, encrypted.length - 12);
                JsonArray array = JsonParser.parseString(new String(plain, StandardCharsets.UTF_8)).getAsJsonArray();
                if (array.size() > MAX_ENTRIES * 2) {
                    throw new IllegalArgumentException("Invalid queue size");
                }
                Gson gson = new Gson();
                for (var element : array) {
                    Delivery value = gson.fromJson(element, Delivery.class);
                    if (value == null || value.id() == null || value.text() == null || value.recipient() == null
                            || value.context() == null || value.text().length() > maxTextLength) {
                        throw new IllegalArgumentException("Invalid delivery");
                    }
                    entries.put(value.id(), value);
                }
            } catch (GeneralSecurityException | RuntimeException error) {
                entries.clear();
                throw new IOException("CLAWBOT_DELIVERY_STORE_INVALID", error);
            }
        }
        loaded = true;
    }

    private void save(String token) throws IOException {
        Files.createDirectories(file.getParent());
        Path temporary = Files.createTempFile(file.getParent(), "pending-deliveries-", ".tmp");
        try {
            byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);
            byte[] encrypted = cipher(Cipher.ENCRYPT_MODE, token, iv)
                    .doFinal(new Gson().toJson(entries.values()).getBytes(StandardCharsets.UTF_8));
            byte[] envelope = Arrays.copyOf(iv, iv.length + encrypted.length);
            System.arraycopy(encrypted, 0, envelope, iv.length, encrypted.length);
            if (envelope.length > MAX_BYTES) {
                throw new IOException("CLAWBOT_DELIVERY_QUEUE_FULL");
            }
            Files.write(temporary, envelope);
            try {
                Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (GeneralSecurityException error) {
            throw new IOException("CLAWBOT_DELIVERY_STORE_UNAVAILABLE", error);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static Cipher cipher(int mode, String token, byte[] iv) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(mac.doFinal(DOMAIN), "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(DOMAIN);
        return cipher;
    }

    record Delivery(String id, String recipient, String context, String text, boolean requireAuthorization, String predecessor,
                    boolean unknown, String groupId, String recoverySource) {
        Delivery(String id, String recipient, String context, String text, boolean requireAuthorization, String predecessor, boolean unknown, String groupId) {
            this(id, recipient, context, text, requireAuthorization, predecessor, unknown, groupId, null);
        }
        Delivery(String id, String recipient, String context, String text, boolean requireAuthorization, String predecessor, boolean unknown) {
            this(id, recipient, context, text, requireAuthorization, predecessor, unknown, null);
        }
        Delivery(String id, String recipient, String context, String text, boolean requireAuthorization, String predecessor) {
            this(id, recipient, context, text, requireAuthorization, predecessor, false);
        }
    }
}
