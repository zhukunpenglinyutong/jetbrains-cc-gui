package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.util.EditorFileUtils;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.ScrollType;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.search.FilenameIndex;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Handles opening files in the editor and opening URLs in the browser.
 */
class OpenFileHandler {

    private static final Logger LOG = Logger.getInstance(OpenFileHandler.class);
    private static final Pattern LINE_INFO_PATTERN = Pattern.compile("^(.*):(\\d+)(?:-(\\d+))?$");

    private final HandlerContext context;

    OpenFileHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Open a file in the editor.
     * Supports file paths with line numbers: file.txt:100 or file.txt:100-200.
     */
    void handleOpenFile(String filePath) {
        LOG.info("Open file request: " + filePath);

        CompletableFuture.runAsync(() -> {
            try {
                LineInfo lineInfo = parseLineInfo(filePath);
                String actualPath = lineInfo.actualPath();
                int lineNumber = lineInfo.lineNumber();
                int endLineNumber = lineInfo.endLineNumber();

                FileResolutionResult resolution = resolveFile(actualPath);

                if (resolution == null) {
                    LOG.warn("File not found: " + actualPath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        context.callJavaScript("addErrorMessage", context.escapeJs("Cannot open file: file does not exist (" + actualPath + ")"));
                    }, ModalityState.nonModal());
                    return;
                }

                // Direct VirtualFile from fuzzy match - skip File conversion
                if (resolution.virtualFile() != null) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (context.getProject().isDisposed() || !resolution.virtualFile().isValid()) {
                            return;
                        }
                        openInEditor(resolution.virtualFile(), lineNumber, endLineNumber);
                        LOG.info("Successfully opened file via fuzzy match: " + filePath);
                    }, ModalityState.nonModal());
                    return;
                }

                // Standard File path resolution
                final File finalFile = resolution.file();
                EditorFileUtils.refreshAndFindFileAsync(finalFile, virtualFile -> {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (context.getProject().isDisposed() || !virtualFile.isValid()) {
                            return;
                        }
                        openInEditor(virtualFile, lineNumber, endLineNumber);
                        LOG.info("Successfully opened file: " + filePath);
                    }, ModalityState.nonModal());
                }, () -> {
                    LOG.error("Failed to get VirtualFile: " + filePath);
                    context.callJavaScript("addErrorMessage", context.escapeJs("Cannot open file: " + filePath));
                });
            } catch (Exception e) {
                LOG.error("Failed to open file: " + e.getMessage(), e);
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    /**
     * Parse line number info from file path.
     */
    static LineInfo parseLineInfo(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return new LineInfo(filePath, -1, -1, false);
        }

        Matcher matcher = LINE_INFO_PATTERN.matcher(filePath);
        if (!matcher.matches()) {
            return new LineInfo(filePath, -1, -1, false);
        }

        String actualPath = matcher.group(1);
        if (actualPath == null || actualPath.isBlank() || actualPath.matches(".*:\\d+$")) {
            return new LineInfo(filePath, -1, -1, false);
        }

        try {
            int lineNumber = Integer.parseInt(matcher.group(2));
            int endLineNumber = matcher.group(3) != null ? Integer.parseInt(matcher.group(3)) : -1;
            if (lineNumber <= 0 || (endLineNumber > 0 && endLineNumber < lineNumber)) {
                return new LineInfo(filePath, -1, -1, false);
            }

            return new LineInfo(actualPath, lineNumber, endLineNumber, true);
        } catch (NumberFormatException e) {
            LOG.warn("Failed to parse line number: " + filePath);
            return new LineInfo(filePath, -1, -1, false);
        }
    }

    /**
     * Resolve file path, handling MSYS paths, relative paths, and fuzzy filename matching.
     * Returns either a direct File path or a VirtualFile from fuzzy matching.
     * Fuzzy matching searches for files by name when the path cannot be resolved directly.
     */
    private FileResolutionResult resolveFile(String actualPath) {
        File directFile = normalizeExistingFile(new File(actualPath));
        if (directFile != null) {
            warnIfOutsideProjectRoot(directFile);
            return new FileResolutionResult(directFile, null);
        }

        String resolvedPath = actualPath;
        if (PlatformUtils.isWindows()) {
            String convertedPath = PathUtils.convertMsysToWindowsPath(actualPath);
            if (!convertedPath.equals(actualPath)) {
                LOG.info("Detected MSYS2 path, converted to Windows path: " + convertedPath);
                File convertedFile = normalizeExistingFile(new File(convertedPath));
                if (convertedFile != null) {
                    warnIfOutsideProjectRoot(convertedFile);
                    return new FileResolutionResult(convertedFile, null);
                }
                resolvedPath = convertedPath;
            }
        }

        File pathCandidate = new File(resolvedPath);
        if (pathCandidate.isAbsolute()) {
            return null;
        }

        for (File baseDirectory : getResolutionBases()) {
            File candidate = normalizeExistingFile(new File(baseDirectory, resolvedPath));
            if (candidate != null) {
                LOG.info("Resolved relative file against " + baseDirectory.getAbsolutePath() + ": " + candidate.getAbsolutePath());
                return new FileResolutionResult(candidate, null);
            }
        }

        // Fallback: fuzzy filename search using IDEA's file index
        VirtualFile fuzzyMatch = resolveFileByFuzzyMatch(actualPath);
        if (fuzzyMatch != null) {
            LOG.info("Resolved file by fuzzy match: " + fuzzyMatch.getPath());
            return new FileResolutionResult(null, fuzzyMatch);
        }

        return null;
    }

    /**
     * Fuzzy file matching: search for files by name in the project scope.
     * Handles cases like "linkify.ts" -> finds "src/utils/linkify.ts".
     * Returns null during dumb mode to avoid IndexNotReadyException.
     */
    private VirtualFile resolveFileByFuzzyMatch(String pathHint) {
        Project project = context.getProject();
        if (project == null || project.isDisposed()) {
            return null;
        }

        // FilenameIndex requires indexes to be ready
        if (DumbService.isDumb(project)) {
            LOG.info("Fuzzy file match deferred during dumb mode for: " + pathHint);
            return null;
        }

        // Extract the filename from the path hint
        String fileName = extractFileName(pathHint);
        if (fileName == null || fileName.isBlank()) {
            return null;
        }

        // Extract path suffix for matching
        String pathSuffix = extractPathSuffix(pathHint);

        // FilenameIndex requires read access
        return ReadAction.compute(() -> {
            // Search for files with matching name in project scope
            Collection<VirtualFile> matches = FilenameIndex.getVirtualFilesByName(
                project,
                fileName,
                GlobalSearchScope.projectScope(project)
            );

            if (matches.isEmpty()) {
                return null;
            }

            // If there's a path hint (e.g., "utils/linkify.ts"), try to match by path suffix
            if (pathSuffix != null && !pathSuffix.isBlank()) {
                for (VirtualFile match : matches) {
                    String matchPath = match.getPath();
                    if (matchPath.endsWith(pathSuffix) || matchPath.contains(pathSuffix)) {
                        return match;
                    }
                }
            }

            // If multiple matches, prefer files in common source directories
            VirtualFile bestMatch = null;
            for (VirtualFile match : matches) {
                String matchPath = match.getPath();
                // Prefer src/, main/, or project root files
                if (matchPath.contains("/src/") || matchPath.contains("\\src\\")) {
                    if (bestMatch == null || !bestMatch.getPath().contains("/src/")) {
                        bestMatch = match;
                    }
                } else if (matchPath.contains("/main/") || matchPath.contains("\\main\\")) {
                    if (bestMatch == null) {
                        bestMatch = match;
                    }
                } else if (bestMatch == null) {
                    bestMatch = match;
                }
            }

            return bestMatch;
        });
    }

    /**
     * Extract the filename from a path string.
     * "src/utils/linkify.ts" -> "linkify.ts"
     * "linkify.ts" -> "linkify.ts"
     */
    // VisibleForTesting
    static String extractFileName(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }

        // Handle both Unix and Windows path separators
        int lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (lastSep >= 0 && lastSep < path.length() - 1) {
            return path.substring(lastSep + 1);
        }

        return path;
    }

    /**
     * Extract the path suffix for matching.
     * "src/utils/linkify.ts" -> "utils/linkify.ts"
     * Used to find files that match the directory structure hint.
     */
    // VisibleForTesting
    static String extractPathSuffix(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }

        // Skip the first directory segment if it's a common root
        String normalized = path.replace('\\', '/');
        String[] segments = normalized.split("/");

        if (segments.length <= 1) {
            return null;
        }

        // Find a meaningful suffix (skip common roots like "src", "main")
        int startIdx = 0;
        if (segments.length > 2) {
            String first = segments[0].toLowerCase();
            if ("src".equals(first) || "main".equals(first) || "java".equals(first) ||
                "kotlin".equals(first) || "webview".equals(first)) {
                startIdx = 1;
            }
        }

        if (startIdx >= segments.length - 1) {
            return null;
        }

        StringBuilder suffix = new StringBuilder();
        for (int i = startIdx; i < segments.length; i++) {
            if (suffix.length() > 0) {
                suffix.append('/');
            }
            suffix.append(segments[i]);
        }

        return suffix.toString();
    }

    private List<File> getResolutionBases() {
        LinkedHashSet<String> basePaths = new LinkedHashSet<>();

        if (context.getSession() != null) {
            String sessionCwd = context.getSession().getCwd();
            if (sessionCwd != null && !sessionCwd.isBlank()) {
                basePaths.add(sessionCwd);
            }
        }

        String customWorkingDirectory = resolveCustomWorkingDirectory();
        if (customWorkingDirectory != null) {
            basePaths.add(customWorkingDirectory);
        }

        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath != null && !projectBasePath.isBlank()) {
            basePaths.add(projectBasePath);
        }

        List<File> bases = new ArrayList<>();
        for (String basePath : basePaths) {
            File directory = normalizeExistingDirectory(basePath);
            if (directory != null) {
                bases.add(directory);
            }
        }
        return bases;
    }

    private String resolveCustomWorkingDirectory() {
        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath == null || projectBasePath.isBlank()) {
            return null;
        }

        try {
            String customWorkingDir = context.getSettingsService().getCustomWorkingDirectory(projectBasePath);
            if (customWorkingDir == null || customWorkingDir.isBlank()) {
                return null;
            }

            File workingDirectory = new File(customWorkingDir);
            if (!workingDirectory.isAbsolute()) {
                workingDirectory = new File(projectBasePath, customWorkingDir);
            }

            File canonicalDirectory = normalizeExistingDirectory(workingDirectory.getPath());
            return canonicalDirectory != null ? canonicalDirectory.getAbsolutePath() : null;
        } catch (Exception e) {
            LOG.warn("Failed to resolve custom working directory: " + e.getMessage());
            return null;
        }
    }

    private File normalizeExistingDirectory(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }

        try {
            File directory = new File(path).getCanonicalFile();
            return directory.exists() && directory.isDirectory() ? directory : null;
        } catch (IOException e) {
            File directory = new File(path).getAbsoluteFile();
            return directory.exists() && directory.isDirectory() ? directory : null;
        }
    }

    private File normalizeExistingFile(File candidate) {
        try {
            File canonicalFile = candidate.getCanonicalFile();
            return canonicalFile.exists() && canonicalFile.isFile() ? canonicalFile : null;
        } catch (IOException e) {
            File absoluteFile = candidate.getAbsoluteFile();
            return absoluteFile.exists() && absoluteFile.isFile() ? absoluteFile : null;
        }
    }

    /**
     * Log a warning when an absolute path resolves outside the current project root.
     * Non-breaking: the file is still opened, but the audit trail records the access.
     */
    private void warnIfOutsideProjectRoot(File resolvedFile) {
        try {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) {
                return;
            }
            String basePath = project.getBasePath();
            if (basePath == null || basePath.isBlank()) {
                return;
            }
            Path projectRoot = Paths.get(basePath).toAbsolutePath().normalize();
            Path resolvedPath = resolvedFile.toPath().toAbsolutePath().normalize();
            if (!resolvedPath.startsWith(projectRoot)) {
                LOG.warn("Opening file outside project root: " + resolvedPath);
            }
        } catch (Exception e) {
            // Best-effort audit logging; never block file open on warning failures.
            LOG.debug("Failed to evaluate project root scope: " + e.getMessage());
        }
    }

    /**
     * Open a virtual file in the editor, optionally navigating to a line range.
     */
    private void openInEditor(VirtualFile virtualFile, int lineNumber, int endLineNumber) {
        Project project = context.getProject();
        if (project == null || project.isDisposed()) {
            return;
        }

        if (lineNumber <= 0) {
            FileEditorManager.getInstance(project).openFile(virtualFile, true);
            return;
        }

        OpenFileDescriptor descriptor = new OpenFileDescriptor(project, virtualFile);
        Editor editor = FileEditorManager.getInstance(project).openTextEditor(descriptor, true);

        if (editor == null) {
            LOG.warn("Cannot open text editor: " + virtualFile.getPath());
            FileEditorManager.getInstance(project).openFile(virtualFile, true);
            return;
        }

        int lineCount = editor.getDocument().getLineCount();
        if (lineCount <= 0) {
            LOG.warn("File is empty, cannot navigate to line " + lineNumber);
            return;
        }

        int zeroBasedLine = Math.min(Math.max(0, lineNumber - 1), lineCount - 1);
        int startOffset = editor.getDocument().getLineStartOffset(zeroBasedLine);
        editor.getCaretModel().moveToOffset(startOffset);

        if (endLineNumber >= lineNumber) {
            int zeroBasedEndLine = Math.min(endLineNumber - 1, lineCount - 1);
            int endOffset = editor.getDocument().getLineEndOffset(zeroBasedEndLine);
            editor.getSelectionModel().setSelection(startOffset, endOffset);
        } else {
            editor.getSelectionModel().removeSelection();
        }

        editor.getScrollingModel().scrollToCaret(ScrollType.CENTER);
    }

    /**
     * Open the browser.
     */
    void handleOpenBrowser(String url) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                BrowserUtil.browse(url);
            } catch (Exception e) {
                LOG.error("Cannot open browser: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Result of file resolution: either a File path or a VirtualFile from fuzzy matching.
     * At most one of the two fields will be non-null.
     */
    static record FileResolutionResult(File file, VirtualFile virtualFile) {
    }

    static record LineInfo(String actualPath, int lineNumber, int endLineNumber, boolean hasLineInfo) {
    }
}
