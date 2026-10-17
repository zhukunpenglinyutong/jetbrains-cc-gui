package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Reads the current Git workspace for a Codex-only /diff command.
 */
public class CodexWorkspaceDiffHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CodexWorkspaceDiffHandler.class);
    private static final Gson GSON = new Gson();
    private static final int MAX_OUTPUT_CHARS = 512 * 1024;
    private static final String[] SUPPORTED_TYPES = {"codex_read_workspace_diff"};
    private final GitLauncher gitLauncher;

    /** Creates a reader for the current chat's effective workspace. */
    public CodexWorkspaceDiffHandler(HandlerContext context) {
        this(context, command -> new ProcessBuilder(command).start());
    }

    CodexWorkspaceDiffHandler(HandlerContext context, GitLauncher gitLauncher) {
        super(context);
        this.gitLauncher = gitLauncher;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"codex_read_workspace_diff".equals(type)) {
            return false;
        }
        readWorkspaceDiff();
        return true;
    }

    private void readWorkspaceDiff() {
        String cwd = this.context.resolveEffectiveWorkingDirectory();
        var session = this.context.getSession();
        String sessionId = session == null ? null : session.getSessionId();
        // Git reads block for up to minutes (per-process timeouts); the common
        // pool must stay free for interrupts and interaction replies.
        CompletableFuture.supplyAsync(() -> this.collectDiff(cwd), CodexSDKBridge.codexControlExecutor())
                .thenAccept(result -> {
                    if (this.context.getSession() == session
                            && java.util.Objects.equals(sessionId, session == null ? null : session.getSessionId())
                            && java.util.Objects.equals(cwd, this.context.resolveEffectiveWorkingDirectory())) {
                        result.addProperty("sessionId", sessionId);
                        this.callJavaScript("onCodexWorkspaceDiff", this.escapeJs(GSON.toJson(result)));
                    }
                })
                .exceptionally(error -> {
                    LOG.warn("[CodexDiff] Workspace diff failed: " + error.getMessage());
                    JsonObject failure = new JsonObject();
                    failure.addProperty("cwd", cwd == null ? "" : cwd);
                    failure.addProperty("repository", false);
                    failure.addProperty("error", error.getMessage() == null ? "Workspace diff failed" : error.getMessage());
                    if (this.context.getSession() == session
                            && java.util.Objects.equals(sessionId, session == null ? null : session.getSessionId())
                            && java.util.Objects.equals(cwd, this.context.resolveEffectiveWorkingDirectory())) {
                        failure.addProperty("sessionId", sessionId);
                        this.callJavaScript("onCodexWorkspaceDiff", this.escapeJs(GSON.toJson(failure)));
                    }
                    return null;
                });
    }

    private JsonObject collectDiff(String cwd) {
        JsonObject result = new JsonObject();
        result.addProperty("cwd", cwd == null ? "" : cwd);
        if (cwd == null || cwd.trim().isEmpty() || !Files.isDirectory(Path.of(cwd))) {
            result.addProperty("repository", false);
            result.addProperty("error", "Working directory is unavailable");
            return result;
        }
        CommandResult probe = this.runGit(cwd, "rev-parse", "--show-toplevel");
        if (probe.exitCode != 0) {
            result.addProperty("repository", false);
            // A negative exit code means git itself failed to start (e.g. not
            // on PATH); reporting that beats a wrong "not a Git repository".
            result.addProperty("error", probe.exitCode < 0 && !probe.output.isBlank()
                    ? probe.output.strip()
                    : "Working directory is not a Git repository");
            return result;
        }
        result.addProperty("repository", true);
        String repository = probe.output.trim();
        result.addProperty("root", repository);
        result.addProperty("readTime", System.currentTimeMillis());
        CommandResult staged = this.runGit(repository, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary");
        CommandResult unstaged = this.runGit(repository, "diff", "--no-ext-diff", "--no-textconv", "--binary");
        result.addProperty("staged", staged.output);
        result.addProperty("unstaged", unstaged.output);
        JsonArray untracked = new JsonArray();
        CommandResult files = this.runGit(repository, "ls-files", "--others", "--exclude-standard", "-z");
        for (String file : files.output.split("\u0000")) {
            if (!file.isBlank()) {
                untracked.add(file);
            }
        }
        result.add("untracked", untracked);
        if (staged.exitCode != 0 || unstaged.exitCode != 0 || files.exitCode != 0) {
            result.addProperty("error", "Git could not read the complete workspace snapshot");
        }
        result.addProperty("truncated", probe.truncated || staged.truncated || unstaged.truncated || files.truncated);
        return result;
    }

    private CommandResult runGit(String cwd, String... args) {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.add("-C");
        command.add(cwd);
        for (String arg : args) {
            command.add(arg);
        }
        Process process = null;
        try {
            // Streams must stay separate: git writes warnings (e.g. CRLF
            // notices) to stderr, and interleaving them into the captured
            // stdout would corrupt the --binary patch sent to Codex.
            process = this.gitLauncher.start(command);
            Process child = process;
            // Drain both pipes concurrently: warnings can fill stderr before
            // stdout reaches EOF, especially with many Windows CRLF notices.
            var read = CompletableFuture.supplyAsync(() -> this.drainGitStream(child.getInputStream()),
                    CodexSDKBridge.codexControlExecutor());
            var readErrors = CompletableFuture.supplyAsync(() -> this.drainGitStream(child.getErrorStream()),
                    CodexSDKBridge.codexControlExecutor());
            boolean finished = process.waitFor(10, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                read.cancel(true);
                readErrors.cancel(true);
                return new CommandResult(-1, "Git workspace read timed out", "", true);
            }
            // The process has exited, so the pipes hold a finite amount of
            // data; large --binary diffs still need a generous drain window.
            CommandResult captured = read.get(30, TimeUnit.SECONDS);
            CommandResult errors = readErrors.get(30, TimeUnit.SECONDS);
            if (process.exitValue() != 0 && !errors.output.isBlank()) {
                LOG.warn("[CodexDiff] git " + args[0] + " stderr: "
                        + errors.output.strip().substring(0, Math.min(500, errors.output.strip().length())));
            }
            return new CommandResult(process.exitValue(), captured.output, errors.output, captured.truncated || errors.truncated);
        } catch (Exception e) {
            if (process != null) {
                process.destroyForcibly();
            }
            return new CommandResult(-1, e.getMessage() == null ? "" : e.getMessage(), "", false);
        }
    }

    private CommandResult drainGitStream(java.io.InputStream stream) {
        StringBuilder output = new StringBuilder();
        boolean truncated = false;
        try (var reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
            char[] buffer = new char[4096];
            int length;
            while ((length = reader.read(buffer)) != -1) {
                int retained = Math.min(length, MAX_OUTPUT_CHARS - output.length());
                output.append(buffer, 0, retained);
                truncated |= retained < length;
            }
        } catch (java.io.IOException error) {
            truncated = true;
        }
        return new CommandResult(0, output.toString(), "", truncated);
    }

    @FunctionalInterface
    interface GitLauncher {
        Process start(List<String> command) throws java.io.IOException;
    }

    private record CommandResult(int exitCode, String output, String errors, boolean truncated) {
    }
}
