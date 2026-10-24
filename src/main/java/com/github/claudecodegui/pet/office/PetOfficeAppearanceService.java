package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.pet.CodexPetFloatingService.VisualConfiguration;
import com.github.claudecodegui.pet.CodexPetImageSupport;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Read admitted selections into bounded byte snapshots. No file stream or Project survives the read permit. */
public final class PetOfficeAppearanceService {
    static final int MAX_IMAGE_BYTES = 4 * 1024 * 1024;
    static final int MAX_CACHE_BYTES = 16 * 1024 * 1024;
    static final int MAX_CACHE_ENTRIES = 8;
    private static final int MAX_METADATA_BYTES = 64 * 1024;
    private static final Gson JSON = new Gson();
    private static final Set<String> MIME_TYPES = Set.of("image/png", "image/jpeg", "image/gif", "image/webp");
    private final ReadRoot readRoot;
    private final ReadAccess access;
    private final Map<String, RawAsset> cache = new LinkedHashMap<>(16, 0.75f, true);
    private final Map<String, CachedSelection> selections = new LinkedHashMap<>();
    private final Map<String, Appearance> currentSelections = new HashMap<>();
    private final Set<String> pinned = new HashSet<>();
    private int cacheBytes;
    private int pinnedBytes;

    @FunctionalInterface
    public interface ReadAccess { AutoCloseable tryAcquire() throws Exception; }

    @FunctionalInterface
    public interface ReadRoot { Path resolve() throws IOException; }

    public record Manifest(String digest, String kind, String mime, int width, int height, int byteLength) { }
    public record Choice(String id, String label) { }

    public record Appearance(String revision, String scope, double opacity, Map<String, List<String>> actionMappings,
                             String status, Manifest manifest) {
        public Appearance {
            Map<String, List<String>> copied = new LinkedHashMap<>();
            actionMappings.forEach((state, actions) -> copied.put(state, List.copyOf(actions)));
            actionMappings = Map.copyOf(copied);
        }
    }

    public PetOfficeAppearanceService(Path root, ReadAccess access) {
        this(() -> root.toAbsolutePath().normalize(), access);
    }

    public PetOfficeAppearanceService(ReadRoot readRoot, ReadAccess access) {
        this.readRoot = Objects.requireNonNull(readRoot);
        this.access = Objects.requireNonNull(access);
    }

    public synchronized void beginSnapshot() {
        pinned.clear();
        pinnedBytes = 0;
        currentSelections.clear();
    }

    static boolean validPetId(String id) {
        if (id == null || id.isEmpty() || id.length() > 256 || id.contains("\\") || id.contains(":")
                || id.codePoints().anyMatch(c -> c < 32 || c == 127)) {
            return false;
        }
        return java.util.Arrays.stream(id.split("/", -1)).noneMatch(part -> part.isBlank() || ".".equals(part) || "..".equals(part));
    }

    /** Enumerate existing local selections under the same read permit and path policy as image admission. */
    public synchronized List<Choice> choices() throws IOException {
        List<Choice> result = new java.util.ArrayList<>();
        result.add(new Choice("builtin", "Built-in robot"));
        try (AutoCloseable permit = access.tryAcquire()) {
            if (permit == null) {
                throw new IOException("OFFICE_ASSET_BUSY");
            }
            Path root = readRoot.resolve().toAbsolutePath().normalize();
            if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
                return List.copyOf(result);
            }
            int visited = 0;
            try (var entries = Files.newDirectoryStream(root)) {
                for (Path entry : entries) {
                    if (++visited > 512) {
                        break;
                    }
                    BasicFileAttributes attributes = Files.readAttributes(entry, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    if (attributes.isSymbolicLink() || attributes.isOther()) {
                        continue;
                    }
                    if (attributes.isDirectory()) {
                        try (var children = Files.newDirectoryStream(entry)) {
                            for (Path child : children) {
                                if (++visited > 512) {
                                    break;
                                }
                                addChoice(result, root, child);
                            }
                        }
                    } else {
                        addChoice(result, root, entry);
                    }
                }
            }
        } catch (IOException failure) {
            throw new IOException("OFFICE_ASSET_UNAVAILABLE");
        } catch (Exception failure) {
            throw new IOException("OFFICE_ASSET_BUSY");
        }
        var sorted = result.subList(1, result.size()).stream().sorted(java.util.Comparator.comparing(Choice::id)).limit(128).toList();
        List<Choice> admitted = new java.util.ArrayList<>();
        admitted.add(result.get(0));
        int encodedBytes = JSON.toJson(admitted).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        for (Choice choice : sorted) {
            int cost = JSON.toJson(choice).getBytes(java.nio.charset.StandardCharsets.UTF_8).length + 1;
            if (encodedBytes + cost > 32000) {
                break;
            }
            admitted.add(choice);
            encodedBytes += cost;
        }
        return List.copyOf(admitted);
    }

    private void addChoice(List<Choice> result, Path root, Path candidate) {
        String id = root.relativize(candidate).toString().replace('\\', '/');
        if (!validPetId(id) || !id.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(png|jpg|jpeg|gif|webp)$")) {
            return;
        }
        try {
            checkedPath(id);
            result.add(new Choice(id, choiceLabel(root, candidate)));
        } catch (IOException invalid) {
            // A removed, linked or oversized candidate is not a selectable Pet.
        }
    }

    /** Match the Pet picker: alias, displayName, then the local package/file name. Metadata is optional. */
    private String choiceLabel(Path root, Path image) {
        String filename = image.getFileName().toString();
        String fallback = image.getParent().equals(root) ? filename.substring(0, filename.lastIndexOf('.')) : image.getParent().getFileName().toString();
        if (fallback.isBlank()) {
            fallback = filename;
        }
        String metadataId = root.relativize(image.getParent().resolve("pet.json")).toString().replace('\\', '/');
        try {
            Path metadata = checkedPath(metadataId);
            BasicFileAttributes before = Files.readAttributes(metadata, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (before.size() > MAX_METADATA_BYTES) {
                return fallback;
            }
            byte[] bytes;
            try (InputStream input = Files.newInputStream(metadata, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
                bytes = input.readNBytes(MAX_METADATA_BYTES + 1);
            }
            if (bytes.length > MAX_METADATA_BYTES || bytes.length != before.size()
                    || !metadata.equals(checkedPath(metadataId))
                    || !stamp(before).equals(stamp(Files.readAttributes(metadata, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS)))) {
                return fallback;
            }
            JsonObject value = JsonParser.parseString(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
            for (String field : List.of("alias", "displayName")) {
                if (!value.has(field) || !value.get(field).isJsonPrimitive() || !value.getAsJsonPrimitive(field).isString()) {
                    continue;
                }
                String label = value.get(field).getAsString().replaceAll("[\\p{Cntrl}\\s]+", " ").trim();
                if (!label.isBlank()) {
                    int length = Math.min(field.equals("alias") ? 60 : 100, label.codePointCount(0, label.length()));
                    return label.substring(0, label.offsetByCodePoints(0, length));
                }
            }
        } catch (IOException | RuntimeException invalid) {
            // Missing, linked, malformed or concurrently changed metadata must not hide an otherwise valid Pet.
        }
        return fallback;
    }

    public synchronized Appearance resolveSession(Appearance inherited, String petId, long generation) {
        if (!validPetId(petId)) {
            throw new IllegalArgumentException("OFFICE_APPEARANCE_INVALID");
        }
        Appearance base = inherited == null ? resolve(defaultConfiguration()) : inherited;
        return resolve(new VisualConfiguration(petId, "session", base.opacity(), base.actionMappings(), generation));
    }

    public synchronized Appearance resolve(VisualConfiguration config) {
        if (config == null) {
            return fallback(defaultConfiguration(), "ASSET_UNAVAILABLE");
        }
        String configKey = digest(JSON.toJson(config).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        Appearance same = currentSelections.get(configKey);
        if (same != null) {
            return same;
        }
        Appearance result;
        if ("builtin".equals(config.selectedPetId())) {
            result = fallback(config, "BUILTIN");
        } else {
            try {
                result = readSelection(config);
            } catch (Exception failure) {
                // Paths/provider error text never cross the display boundary.
                result = fallback(config, "ASSET_UNAVAILABLE");
            }
        }
        currentSelections.put(configKey, result);
        return result;
    }

    private Appearance readSelection(VisualConfiguration config) throws Exception {
        if (selections.size() >= MAX_CACHE_ENTRIES && !selections.containsKey(config.selectedPetId())) {
            selections.entrySet().removeIf(entry -> !pinned.contains(entry.getValue().manifest.digest()));
            if (selections.size() >= MAX_CACHE_ENTRIES) {
                return fallback(config, "ASSET_CAPACITY");
            }
        }
        ByteSnapshot captured;
        try (AutoCloseable permit = access.tryAcquire()) {
            if (permit == null) {
                CachedSelection previous = selections.get(config.selectedPetId());
                RawAsset cached = previous == null ? null : cache.get(previous.manifest.digest());
                return cached != null && admit(cached) ? appearance(config, "ASSET_BUSY", cached.manifest) : fallback(config, "ASSET_BUSY");
            }
            captured = captureBytes(config);
        }
        // Header inspection, hashing and cache admission take place after releasing migration/read exclusion.
        if (captured.cached != null) {
            return admit(captured.cached) ? appearance(config, "READY", captured.cached.manifest) : fallback(config, "ASSET_CAPACITY");
        }
        byte[] bytes = captured.bytes;
        Path path = captured.path;
        String mime = CodexPetImageSupport.detectMimeType(path, bytes);
        CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mime, bytes);
        if (!MIME_TYPES.contains(mime) || !CodexPetImageSupport.hasSafeDimensions(dimensions)
                || !CodexPetImageSupport.hasSafeFrameBudget(mime, bytes)) {
            throw new IOException("ASSET_INVALID");
        }
        String digest = digest(bytes);
        String kind = CodexPetImageSupport.isCanonicalPetdexSheet(dimensions) ? "sheet" : "image";
        Manifest manifest = new Manifest(digest, kind, mime, dimensions.getWidth(), dimensions.getHeight(), bytes.length);
        RawAsset asset = new RawAsset(manifest, bytes);
        if (!admit(asset)) {
            return fallback(config, "ASSET_CAPACITY");
        }
        if (!cache.containsKey(digest)) {
            evictFor(bytes.length);
            cache.put(digest, asset);
            cacheBytes += bytes.length;
        }
        selections.put(config.selectedPetId(), new CachedSelection(path, captured.stamp, manifest, config.generation()));
        return appearance(config, "READY", manifest);
    }

    private ByteSnapshot captureBytes(VisualConfiguration config) throws IOException {
        Path path = checkedPath(config.selectedPetId());
        BasicFileAttributes before = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        CachedSelection previous = selections.get(config.selectedPetId());
        RawAsset cached = previous == null ? null : cache.get(previous.manifest.digest());
        if (cached != null && previous.generation == config.generation() && previous.stamp.equals(stamp(before)) && previous.path.equals(path)) {
            return new ByteSnapshot(path, previous.stamp, null, cached);
        }
        byte[] bytes;
        try (InputStream input = Files.newInputStream(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            bytes = input.readNBytes(MAX_IMAGE_BYTES + 1);
        }
        if (bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES || bytes.length != before.size()) {
            throw new IOException("ASSET_INVALID");
        }
        Path afterPath = checkedPath(config.selectedPetId());
        BasicFileAttributes after = Files.readAttributes(afterPath, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!path.equals(afterPath) || !stamp(before).equals(stamp(after))) {
            throw new IOException("ASSET_CHANGED");
        }
        return new ByteSnapshot(path, stamp(after), bytes, null);
    }

    private boolean admit(RawAsset asset) {
        if (pinned.contains(asset.manifest.digest())) {
            return true;
        }
        if (pinned.size() >= MAX_CACHE_ENTRIES || pinnedBytes + asset.bytes.length > MAX_CACHE_BYTES) {
            return false;
        }
        pinned.add(asset.manifest.digest());
        pinnedBytes += asset.bytes.length;
        return true;
    }

    private void evictFor(int bytes) {
        var iterator = cache.entrySet().iterator();
        while ((cacheBytes + bytes > MAX_CACHE_BYTES || cache.size() >= MAX_CACHE_ENTRIES) && iterator.hasNext()) {
            RawAsset value = iterator.next().getValue();
            if (!pinned.contains(value.manifest.digest())) {
                cacheBytes -= value.bytes.length;
                iterator.remove();
            }
        }
    }

    private Path checkedPath(String id) throws IOException {
        if (id == null || id.length() > 512 || id.contains("\\") || id.contains(":") || id.startsWith("/") || id.indexOf('\0') >= 0) {
            throw new IOException("ASSET_INVALID");
        }
        for (String part : id.split("/", -1)) {
            if (part.isBlank() || ".".equals(part) || "..".equals(part)) {
                throw new IOException("ASSET_INVALID");
            }
        }
        Path root = readRoot.resolve().toAbsolutePath().normalize();
        Path candidate = root.resolve(id).normalize();
        if (!candidate.startsWith(root)) {
            throw new IOException("ASSET_INVALID");
        }
        // The resolver admits a verified migrated home; all links below its physical Pet root still fail closed.
        Path current = candidate.getRoot();
        for (Path part : candidate) {
            current = current.resolve(part);
            BasicFileAttributes attributes = Files.readAttributes(current, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (attributes.isSymbolicLink() || attributes.isOther() || (!current.equals(candidate) && !attributes.isDirectory())) {
                throw new IOException("ASSET_INVALID");
            }
        }
        BasicFileAttributes attributes = Files.readAttributes(candidate, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isRegularFile() || attributes.size() <= 0 || attributes.size() > MAX_IMAGE_BYTES) {
            throw new IOException("ASSET_INVALID");
        }
        return candidate;
    }

    public synchronized byte[] bytes(Manifest manifest) {
        RawAsset value = cache.get(manifest.digest());
        return value != null && value.manifest.equals(manifest) ? value.bytes.clone() : null;
    }

    public synchronized void clear() {
        cache.clear();
        selections.clear();
        currentSelections.clear();
        pinned.clear();
        cacheBytes = 0;
        pinnedBytes = 0;
    }

    private static String stamp(BasicFileAttributes attributes) {
        return attributes.size() + "/" + attributes.lastModifiedTime() + "/" + attributes.creationTime() + "/" + attributes.fileKey();
    }

    private static Appearance fallback(VisualConfiguration config, String status) {
        return appearance(config, status, new Manifest("", "builtin", "", 192, 208, 0));
    }

    private static Appearance appearance(VisualConfiguration config, String status, Manifest manifest) {
        String revision = digest((JSON.toJson(config) + "/" + manifest.digest()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return new Appearance(revision, config.scope(), config.opacity(), config.actionMappings(), status, manifest);
    }

    public static VisualConfiguration defaultConfiguration() {
        return new VisualConfiguration("builtin", "project", 1.0, Map.of("idle", List.of("idle"), "running", List.of("running"),
                "thinking", List.of("review"), "success", List.of("jumping"), "error", List.of("failed")), 0);
    }

    static String digest(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException("SHA-256 unavailable", unavailable);
        }
    }

    private record RawAsset(Manifest manifest, byte[] bytes) { }
    private record CachedSelection(Path path, String stamp, Manifest manifest, long generation) { }
    private record ByteSnapshot(Path path, String stamp, byte[] bytes, RawAsset cached) { }
}
