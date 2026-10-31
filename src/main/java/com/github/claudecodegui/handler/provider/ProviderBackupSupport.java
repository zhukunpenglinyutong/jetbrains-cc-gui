package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.ProviderBackupCodec;
import com.github.claudecodegui.settings.ProviderBackupService;
import com.github.claudecodegui.util.SafeJsonFileOps;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.fileChooser.FileChooserFactory;
import com.intellij.openapi.fileChooser.FileSaverDescriptor;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileWrapper;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native file dialogs stay on EDT; parsing, cryptography and persistence stay off EDT. */
final class ProviderBackupSupport {
    private static final Gson GSON = new Gson();
    // Enough positions for the user to find damaged entries without flooding the toast.
    private static final int MAX_REPORTED_SKIPPED = 20;
    private final HandlerContext context;
    private final AtomicBoolean busy = new AtomicBoolean();
    // At most one selected path per engine. The webview cannot ask us to read an arbitrary path.
    private final Map<String, Selection> selections = new ConcurrentHashMap<>();

    private record Selection(String token, Path path, byte[] digest) {}

    ProviderBackupSupport(HandlerContext context) {
        this.context = context;
    }

    void handle(String content) {
        Request request;
        try {
            request = GSON.fromJson(content, Request.class);
            if (request == null || request.requestId == null || request.requestId.length() > 128
                    || request.action == null || request.dialogTitle == null || request.dialogTitle.length() > 512) {
                return;
            }
            ProviderBackupCodec.checkEngine(request.engine);
        } catch (Exception ignored) {
            return;
        }
        HandlerContext.JsSender sender = context.captureJavaScriptExecutor();
        if (!busy.compareAndSet(false, true)) {
            reply(sender, request, "busy", null);
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (context.isDisposed()) {
                request.password = null;
                busy.set(false);
                return;
            }
            try {
                switch (request.action) {
                    case "select" -> select(request, sender);
                    case "export" -> export(request, sender);
                    case "import" -> run(request, sender, () -> importSelected(request));
                    default -> finish(sender, request, "invalidFile", null);
                }
            } catch (Exception ignored) {
                finish(sender, request, "failed", null);
            }
        });
    }

    private void select(Request request, HandlerContext.JsSender sender) {
        FileChooserDescriptor descriptor = new FileChooserDescriptor(true, false, false, false, false, false);
        descriptor.setTitle(request.dialogTitle);
        descriptor.withFileFilter(file -> file.getExtension() != null && file.getExtension().equalsIgnoreCase("json"));
        VirtualFile file = FileChooser.chooseFile(descriptor, context.getProject(), null);
        if (file == null) {
            finish(sender, request, "cancelled", null);
            return;
        }
        Path path = Path.of(file.getPath());
        run(request, sender, () -> {
            byte[] bytes = readBounded(path);
            try {
                JsonObject envelope = ProviderBackupCodec.inspect(bytes, request.engine);
                String token = UUID.randomUUID().toString();
                selections.put(request.engine, new Selection(token, path, digest(bytes)));
                JsonObject result = new JsonObject();
                result.addProperty("selection", token);
                result.addProperty("fileName", path.getFileName().toString());
                result.addProperty("encrypted", envelope.get("encrypted").getAsBoolean());
                return result;
            } finally {
                Arrays.fill(bytes, (byte) 0);
            }
        });
    }

    private void export(Request request, HandlerContext.JsSender sender) {
        FileSaverDescriptor descriptor = new FileSaverDescriptor(request.dialogTitle, "", "json");
        VirtualFileWrapper file = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, context.getProject())
                .save((VirtualFile) null, "ccgui-" + request.engine + "-providers.json");
        if (file == null) {
            finish(sender, request, "cancelled", null);
            return;
        }
        Path target = file.getFile().toPath();
        run(request, sender, () -> {
            Path configPath = Path.of(context.getSettingsService().getConfigPath());
            if (target.toAbsolutePath().normalize().equals(configPath.toAbsolutePath().normalize())
                    || (Files.exists(target) && Files.exists(configPath) && Files.isSameFile(target, configPath))) {
                throw new ProviderBackupCodec.BackupException("failed");
            }
            JsonObject config = SafeJsonFileOps.readJsonObjectStrict(configPath, 3, 50);
            ProviderBackupService.ExportResult exported = ProviderBackupService.exportPayload(
                    config == null ? new JsonObject() : config, request.engine);
            char[] password = password(request);
            byte[] bytes = null;
            try {
                bytes = ProviderBackupCodec.encode(request.engine, exported.payload(), password);
                writeBackup(target, bytes);
                return exportSummary(exported);
            } finally {
                Arrays.fill(password, '\0');
                if (bytes != null) {
                    Arrays.fill(bytes, (byte) 0);
                }
            }
        });
    }

    private JsonObject importSelected(Request request) throws IOException {
        Selection selection = selections.get(request.engine);
        if (selection == null || !selection.token().equals(request.selection)) {
            throw new ProviderBackupCodec.BackupException("selectFile");
        }
        byte[] bytes = readBounded(selection.path());
        char[] password = password(request);
        try {
            // Bind the password prompt to the exact file selected, not just its path.
            if (!MessageDigest.isEqual(selection.digest(), digest(bytes))) {
                throw new ProviderBackupCodec.BackupException("invalidFile");
            }
            JsonObject payload = ProviderBackupCodec.decode(bytes, request.engine, password);
            if (context.isDisposed()) {
                throw new ProviderBackupCodec.BackupException("cancelled");
            }
            ProviderBackupService.MergeResult merged = context.getSettingsService()
                    .importProviderBackup(request.engine, payload);
            selections.remove(request.engine, selection);
            JsonObject result = new JsonObject();
            result.addProperty("imported", merged.imported());
            result.addProperty("skipped", merged.skipped());
            return result;
        } finally {
            Arrays.fill(password, '\0');
            Arrays.fill(bytes, (byte) 0);
        }
    }

    /** Counts and saved-provider positions only; never names or config values. */
    static JsonObject exportSummary(ProviderBackupService.ExportResult exported) {
        JsonObject result = new JsonObject();
        result.addProperty("exported", exported.payload().getAsJsonArray("providers").size());
        result.addProperty("skipped", exported.skippedProviders().size());
        JsonArray positions = new JsonArray();
        exported.skippedProviders().stream().limit(MAX_REPORTED_SKIPPED).forEach(positions::add);
        result.add("skippedProviders", positions);
        return result;
    }

    private static char[] password(Request request) {
        return request.password == null ? new char[0] : request.password.toCharArray();
    }

    private static byte[] digest(byte[] bytes) throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 unavailable", e);
        }
    }

    private void run(Request request, HandlerContext.JsSender sender, Operation operation) {
        // Any native dialog has closed by now. The webview starts its processing timeout on this
        // signal, so time spent choosing a file never counts against the operation.
        reply(sender, request, "processing", null);
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                if (context.isDisposed()) {
                    finish(sender, request, "cancelled", null);
                    return;
                }
                JsonObject result = operation.run();
                finish(sender, request, "success", result);
            } catch (ProviderBackupCodec.BackupException e) {
                finish(sender, request, e.getMessage(), e.details());
            } catch (Exception ignored) {
                // No raw parser errors, paths, passwords or provider payloads in logs/toasts.
                finish(sender, request, "failed", null);
            }
        });
    }

    private void finish(HandlerContext.JsSender sender, Request request, String status, JsonObject result) {
        request.password = null;
        busy.set(false);
        reply(sender, request, status, result);
    }

    private static void reply(HandlerContext.JsSender sender, Request request, String status, JsonObject result) {
        JsonObject response = result == null ? new JsonObject() : result;
        response.addProperty("requestId", request.requestId);
        response.addProperty("engine", request.engine);
        response.addProperty("status", status);
        sender.send("window.dispatchEvent(new CustomEvent('provider-backup-result', {detail: "
                + GSON.toJson(response) + "}));");
    }

    static byte[] readBounded(Path path) throws IOException {
        if (!Files.isRegularFile(path) || Files.size(path) > ProviderBackupCodec.MAX_FILE_BYTES) {
            throw new ProviderBackupCodec.BackupException("tooLarge");
        }
        try (var input = Files.newInputStream(path)) {
            byte[] bytes = input.readNBytes(ProviderBackupCodec.MAX_FILE_BYTES + 1);
            if (bytes.length > ProviderBackupCodec.MAX_FILE_BYTES) {
                Arrays.fill(bytes, (byte) 0);
                throw new ProviderBackupCodec.BackupException("tooLarge");
            }
            return bytes;
        }
    }

    private static void writeBackup(Path target, byte[] bytes) throws IOException {
        Path temp = Files.createTempFile(target.toAbsolutePath().getParent(), ".ccgui-backup-", ".tmp");
        try {
            // Temp files are owner-only on POSIX; replace atomically, never truncate an existing backup.
            Files.write(temp, bytes);
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    @FunctionalInterface
    private interface Operation {
        JsonObject run() throws IOException;
    }

    private static final class Request {
        String requestId;
        String engine;
        String action;
        String dialogTitle;
        String password;
        String selection;
    }
}
