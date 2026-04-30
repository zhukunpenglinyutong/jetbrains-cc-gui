package com.github.claudecodegui.handler.file;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.IndexNotReadyException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Computable;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.search.FilenameIndex;
import com.intellij.psi.search.GlobalSearchScope;

import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Resolves AI-rendered file references to real project file paths.
 */
class FileReferenceResolver {

    private static final List<String> LOW_PRIORITY_SEGMENTS = List.of(
            "/target/",
            "/build/",
            "/out/",
            "/node_modules/",
            "/.git/"
    );

    private final Project project;
    private final String sessionCwd;
    private final String projectBasePath;

    FileReferenceResolver(Project project, String sessionCwd, String projectBasePath) {
        this.project = project;
        this.sessionCwd = sessionCwd;
        this.projectBasePath = projectBasePath;
    }

    ResolveResult resolve(ResolveRequest request) {
        if (request == null || isBlank(request.pathText) || request.line < 0) {
            return ResolveResult.unresolved(
                    request != null ? request.id : "",
                    request != null ? request.pathText : "",
                    request != null ? request.line : -1,
                    "invalid_path"
            );
        }

        if (hasTraversalSegment(request.pathText)) {
            return ResolveResult.unresolved(request.id, request.pathText, request.line, "invalid_path");
        }

        Path directPath = toPathOrNull(request.pathText);
        if (directPath != null && directPath.isAbsolute() && Files.isRegularFile(directPath)) {
            return ResolveResult.resolved(request, normalizePath(directPath));
        }

        if (!isSimpleFilename(request.pathText)) {
            ResolveResult relativeResult = resolveRelativePath(request);
            if (relativeResult.resolved) {
                return relativeResult;
            }
        }

        ResolveResult indexedResult = resolveByFilename(request);
        if (indexedResult != null) {
            return indexedResult;
        }

        return ResolveResult.unresolved(request.id, request.pathText, request.line, "not_found");
    }

    private ResolveResult resolveRelativePath(ResolveRequest request) {
        for (String basePath : new String[]{sessionCwd, projectBasePath}) {
            if (isBlank(basePath)) {
                continue;
            }

            Path base = toPathOrNull(basePath);
            if (base == null) {
                continue;
            }

            Path candidate = base.resolve(request.pathText).normalize();
            if (Files.isRegularFile(candidate)) {
                return ResolveResult.resolved(request, normalizePath(candidate));
            }
        }
        return ResolveResult.unresolved(request.id, request.pathText, request.line, "not_found");
    }

    private ResolveResult resolveByFilename(ResolveRequest request) {
        if (project == null || project.isDisposed()) {
            return null;
        }

        DumbService dumbService = DumbService.getInstance(project);
        if (dumbService.isDumb()) {
            return ResolveResult.unresolved(request.id, request.pathText, request.line, "dumb_mode");
        }

        try {
            List<Path> candidates = ApplicationManager.getApplication().runReadAction(
                    (Computable<List<Path>>) () -> {
                        List<Path> paths = new ArrayList<>();
                        String filename = Paths.get(request.pathText).getFileName().toString();
                        for (VirtualFile file : FilenameIndex.getVirtualFilesByName(
                                filename,
                                GlobalSearchScope.projectScope(project)
                        )) {
                            if (file != null && file.isValid() && !file.isDirectory()) {
                                paths.add(Paths.get(file.getPath()));
                            }
                        }
                        return paths;
                    }
            );

            if (candidates.isEmpty()) {
                return null;
            }

            List<Path> sorted = sortCandidates(request.pathText, projectBasePath, candidates);
            return ResolveResult.resolved(request, normalizePath(sorted.get(0)));
        } catch (IndexNotReadyException e) {
            return ResolveResult.unresolved(request.id, request.pathText, request.line, "dumb_mode");
        } catch (RuntimeException e) {
            return ResolveResult.unresolved(request.id, request.pathText, request.line, "error");
        }
    }

    static List<Path> sortCandidates(String pathText, String projectBasePath, List<Path> candidates) {
        List<Path> sorted = new ArrayList<>(candidates);
        sorted.sort(candidateComparator(pathText, projectBasePath));
        return sorted;
    }

    private static Comparator<Path> candidateComparator(String pathText, String projectBasePath) {
        String normalizedPathText = normalizeTextPath(pathText).toLowerCase(Locale.ROOT);
        String normalizedProjectBase = normalizeTextPath(projectBasePath).toLowerCase(Locale.ROOT);

        return Comparator
                .comparingInt((Path path) -> matchesPathText(path, normalizedPathText) ? 0 : 1)
                .thenComparingInt(path -> isInProject(path, normalizedProjectBase) ? 0 : 1)
                .thenComparingInt(path -> containsSegment(path, "/src/main/") ? 0 : 1)
                .thenComparingInt(path -> containsSegment(path, "/src/test/") ? 0 : 1)
                .thenComparingInt(path -> hasLowPrioritySegment(path) ? 1 : 0)
                .thenComparing(path -> normalizeTextPath(path.toString()).toLowerCase(Locale.ROOT));
    }

    private static boolean matchesPathText(Path path, String normalizedPathText) {
        String normalizedPath = normalizeTextPath(path.toString()).toLowerCase(Locale.ROOT);
        if (!normalizedPathText.contains("...")) {
            return normalizedPath.endsWith(normalizedPathText);
        }

        int searchFrom = 0;
        for (String part : normalizedPathText.split("\\.\\.\\.", -1)) {
            if (part.isBlank()) {
                continue;
            }

            int index = normalizedPath.indexOf(part, searchFrom);
            if (index < 0) {
                return false;
            }
            searchFrom = index + part.length();
        }
        return true;
    }

    private static boolean isInProject(Path path, String normalizedProjectBase) {
        if (isBlank(normalizedProjectBase)) {
            return false;
        }
        String normalizedPath = normalizeTextPath(path.toString()).toLowerCase(Locale.ROOT);
        return normalizedPath.equals(normalizedProjectBase)
                       || normalizedPath.startsWith(normalizedProjectBase + "/");
    }

    private static boolean containsSegment(Path path, String segment) {
        return normalizeTextPath(path.toString()).toLowerCase(Locale.ROOT).contains(segment);
    }

    private static boolean hasLowPrioritySegment(Path path) {
        String normalized = normalizeTextPath(path.toString()).toLowerCase(Locale.ROOT);
        for (String segment : LOW_PRIORITY_SEGMENTS) {
            if (normalized.contains(segment)) {
                return true;
            }
        }
        return false;
    }

    private static Path toPathOrNull(String value) {
        try {
            return Paths.get(value);
        } catch (InvalidPathException e) {
            return null;
        }
    }

    private static boolean isSimpleFilename(String pathText) {
        return !pathText.contains("/") && !pathText.contains("\\");
    }

    private static boolean hasTraversalSegment(String pathText) {
        String normalized = normalizeTextPath(pathText);
        return normalized.equals("..")
                       || normalized.startsWith("../")
                       || normalized.contains("/../")
                       || normalized.endsWith("/..");
    }

    private static String normalizePath(Path path) {
        return normalizeTextPath(path.normalize().toString());
    }

    private static String normalizeTextPath(String path) {
        return path == null ? "" : path.replace('\\', '/').trim();
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    static class ResolveRequest {
        final String id;
        final String pathText;
        final int line;

        ResolveRequest(String id, String pathText, int line) {
            this.id = id;
            this.pathText = pathText;
            this.line = line;
        }
    }

    static class ResolveResult {
        final String id;
        final String pathText;
        final String resolvedPath;
        final int line;
        final boolean resolved;
        final String reason;

        private ResolveResult(
                String id,
                String pathText,
                String resolvedPath,
                int line,
                boolean resolved,
                String reason
        ) {
            this.id = id;
            this.pathText = pathText;
            this.resolvedPath = resolvedPath;
            this.line = line;
            this.resolved = resolved;
            this.reason = reason;
        }

        static ResolveResult resolved(ResolveRequest request, String resolvedPath) {
            return new ResolveResult(request.id, request.pathText, resolvedPath, request.line, true, null);
        }

        static ResolveResult unresolved(String id, String pathText, int line, String reason) {
            return new ResolveResult(id, pathText, null, line, false, reason);
        }
    }
}
