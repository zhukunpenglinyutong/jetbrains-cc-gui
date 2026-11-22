package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.io.File;
import java.io.IOException;
import java.nio.file.DirectoryIteratorException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Resolves physical file-system paths back to the path shape visible inside the IDE project.
 */
public final class ProjectPathResolver {

    private static final Logger LOG = Logger.getInstance(ProjectPathResolver.class);
    private static final int MAX_LINK_SCAN_DEPTH = 4;
    private static final int MAX_LINK_SCAN_ENTRIES = 5000;
    private static final long LINK_SCAN_CACHE_TTL_MS = 30000L;
    private static final int MAX_RESOLVABLE_PATH_LENGTH = 4096;

    private static final Set<String> SKIPPED_DIRECTORY_NAMES = Set.of(
            ".git",
            ".gradle",
            ".idea",
            "build",
            "node_modules",
            "Library",
            "Temp",
            "Logs",
            "obj",
            "bin"
    );

    private static final ConcurrentHashMap<String, LinkScanCache> LINK_SCAN_CACHE =
            new ConcurrentHashMap<>();

    private ProjectPathResolver() {
    }

    /**
     * Makes a path absolute and folds "." and ".." the way the filesystem would. Lexical folding
     * alone picks the wrong file when a link precedes "..": the filesystem walks up from the
     * link's target. A link path is kept whenever it still names the same directory.
     */
    public static Path normalizeDotSegments(Path path) {
        Path absolute = path.toAbsolutePath();
        Path lexical = absolute.normalize();
        // Win32 folds ".." before reaching the disk, and paths this long cannot resolve at all.
        if (lexical.equals(absolute) || PlatformUtils.isWindows()
                || absolute.toString().length() > MAX_RESOLVABLE_PATH_LENGTH) {
            return lexical;
        }

        Path current = absolute.getRoot();
        for (Path segment : absolute) {
            String name = segment.toString();
            if ("..".equals(name)) {
                current = parentOnDisk(current);
            } else if (!".".equals(name)) {
                current = current.resolve(segment);
            }
        }
        return current;
    }

    private static Path parentOnDisk(Path path) {
        Path lexicalParent = path.getParent();
        if (lexicalParent == null) {
            return path;
        }

        try {
            Path real = path.toRealPath();
            Path realParent = real.getParent() != null ? real.getParent() : real;
            return Files.isSameFile(lexicalParent, realParent) ? lexicalParent : realParent;
        } catch (IOException | SecurityException e) {
            // A missing directory has no target to walk up from.
            return lexicalParent;
        }
    }

    public static File preferProjectPath(Project project, File candidate) {
        if (candidate == null) {
            return null;
        }

        Path candidatePath = toAbsoluteNormalizedPath(candidate);
        if (candidatePath == null) {
            return candidate;
        }

        Path projectPath = mapToProjectPath(project, candidatePath);
        return (projectPath != null ? projectPath : candidatePath).toFile();
    }

    public static String preferProjectPath(Project project, String filePath) {
        Path candidatePath = resolveInputPath(project, filePath);
        if (candidatePath == null) {
            return filePath;
        }

        Path projectPath = mapToProjectPath(project, candidatePath);
        return formatPath(projectPath != null ? projectPath : candidatePath);
    }

    /** Navigation membership only; mutation callers must use the canonical WslPathUtil boundary. */
    public static boolean isProjectNavigationPath(Project project, String filePath) {
        Path projectRoot = getProjectRoot(project);
        Path candidatePath = resolveInputPath(project, filePath);
        if (projectRoot == null || candidatePath == null) {
            return false;
        }

        if (startsWithPath(candidatePath, projectRoot)) {
            return true;
        }

        Path projectPath = mapToProjectPath(project, candidatePath);
        if (projectPath != null && startsWithPath(projectPath, projectRoot)) {
            return true;
        }

        Path candidateRealPath = resolveRealPathOrSelf(candidatePath);
        Path projectRealPath = resolveRealPathOrSelf(projectRoot);
        return startsWithPath(candidateRealPath, projectRealPath);
    }

    public static String toProjectRelativeOrAbsolute(Project project, String path) {
        Path projectRoot = getProjectRoot(project);
        Path candidatePath = resolveInputPath(project, path);
        if (candidatePath == null) {
            return null;
        }

        Path displayPath = candidatePath;
        Path projectPath = mapToProjectPath(project, candidatePath);
        if (projectPath != null) {
            displayPath = projectPath;
        } else if (projectRoot == null || !startsWithPath(candidatePath, projectRoot)) {
            displayPath = resolveRealPathOrSelf(candidatePath);
        }

        if (projectRoot != null && startsWithPath(displayPath, projectRoot)) {
            String relativePath = relativize(projectRoot, displayPath);
            return relativePath == null || relativePath.isBlank() ? "." : relativePath;
        }

        return formatPath(displayPath);
    }

    public static Path mapToProjectPath(Project project, Path rawPath) {
        Path projectRoot = getProjectRoot(project);
        if (projectRoot == null || rawPath == null) {
            return null;
        }

        Path candidatePath = normalizeDotSegments(rawPath);
        if (startsWithPath(candidatePath, projectRoot)) {
            return candidatePath;
        }

        Path candidateRealPath = resolveRealPathOrSelf(candidatePath);
        Path projectRealPath = resolveRealPathOrSelf(projectRoot);

        Path rootMappedPath = mapByPrefix(candidateRealPath, projectRealPath, projectRoot);
        if (rootMappedPath != null) {
            return rootMappedPath;
        }

        for (LinkedRoot linkedRoot : getLinkedRoots(projectRoot)) {
            Path mappedPath = mapByPrefix(candidateRealPath, linkedRoot.realPath(), linkedRoot.projectPath());
            if (mappedPath != null) {
                return mappedPath;
            }

            mappedPath = mapByPrefix(candidatePath, linkedRoot.realPath(), linkedRoot.projectPath());
            if (mappedPath != null) {
                return mappedPath;
            }
        }

        return null;
    }

    private static Path getProjectRoot(Project project) {
        if (project == null || project.isDisposed()) {
            return null;
        }

        String basePath = project.getBasePath();
        if (basePath == null || basePath.isBlank()) {
            return null;
        }

        try {
            return Paths.get(basePath).toAbsolutePath().normalize();
        } catch (InvalidPathException e) {
            LOG.debug("Invalid project base path: " + basePath);
            return null;
        }
    }

    private static Path resolveInputPath(Project project, String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return null;
        }

        try {
            Path path = Paths.get(filePath);
            if (path.isAbsolute()) {
                return normalizeDotSegments(path);
            }

            Path projectRoot = getProjectRoot(project);
            return normalizeDotSegments(projectRoot != null ? projectRoot.resolve(path) : path);
        } catch (InvalidPathException e) {
            LOG.debug("Invalid file path: " + filePath);
            return null;
        }
    }

    private static Path toAbsoluteNormalizedPath(File file) {
        try {
            return normalizeDotSegments(file.toPath());
        } catch (InvalidPathException e) {
            LOG.debug("Invalid file path: " + file.getPath());
            return null;
        }
    }

    private static Path resolveRealPathOrSelf(Path path) {
        if (path == null) {
            return null;
        }

        try {
            return path.toRealPath().normalize();
        } catch (IOException ignored) {
            return resolveExistingAncestor(path);
        }
    }

    private static Path resolveExistingAncestor(Path path) {
        Deque<Path> suffix = new ArrayDeque<>();
        Path current = path.toAbsolutePath().normalize();

        while (current != null) {
            if (Files.exists(current)) {
                try {
                    Path resolved = current.toRealPath().normalize();
                    for (Path segment : suffix) {
                        resolved = resolved.resolve(segment);
                    }
                    return resolved.normalize();
                } catch (IOException ignored) {
                    break;
                }
            }

            Path fileName = current.getFileName();
            if (fileName != null) {
                suffix.addFirst(fileName);
            }
            current = current.getParent();
        }

        return path.toAbsolutePath().normalize();
    }

    private static List<LinkedRoot> getLinkedRoots(Path projectRoot) {
        String cacheKey = formatPath(projectRoot);
        long now = System.currentTimeMillis();
        LinkScanCache cached = LINK_SCAN_CACHE.get(cacheKey);
        if (cached != null && now - cached.createdAtMs() < LINK_SCAN_CACHE_TTL_MS) {
            return cached.linkedRoots();
        }

        List<LinkedRoot> linkedRoots = scanLinkedRoots(projectRoot);
        LINK_SCAN_CACHE.put(cacheKey, new LinkScanCache(now, linkedRoots));
        return linkedRoots;
    }

    /**
     * Breadth-first, because links usually sit near the root: a large sibling tree must not use
     * up the budget before they are reached.
     */
    private static List<LinkedRoot> scanLinkedRoots(Path projectRoot) {
        List<LinkedRoot> linkedRoots = new ArrayList<>();
        if (!Files.isDirectory(projectRoot)) {
            return linkedRoots;
        }

        Deque<ScanDirectory> pending = new ArrayDeque<>();
        pending.add(new ScanDirectory(projectRoot, 0));
        int visitedEntries = 0;
        while (!pending.isEmpty()) {
            ScanDirectory current = pending.poll();
            try (DirectoryStream<Path> entries = Files.newDirectoryStream(current.path())) {
                for (Path entry : entries) {
                    visitedEntries++;
                    if (visitedEntries > MAX_LINK_SCAN_ENTRIES) {
                        LOG.info("Stopped scanning for project links after " + MAX_LINK_SCAN_ENTRIES
                                + " entries; deeper links in " + projectRoot + " open by their physical path");
                        return linkedRoots;
                    }
                    visitScanEntry(entry, current.depth() + 1, linkedRoots, pending);
                }
            } catch (IOException | DirectoryIteratorException | SecurityException e) {
                LOG.debug("Failed to scan project directory " + current.path() + ": " + e.getMessage());
            }
        }

        return linkedRoots;
    }

    private static void visitScanEntry(Path entry, int depth, List<LinkedRoot> linkedRoots, Deque<ScanDirectory> pending) {
        // Windows junctions report as directories here, so directories need the link check as well.
        boolean directory = Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS);
        if (!directory && !Files.isSymbolicLink(entry)) {
            return;
        }

        LinkedRoot linkedRoot = toLinkedRoot(entry);
        if (linkedRoot != null) {
            linkedRoots.add(linkedRoot);
        } else if (directory && depth < MAX_LINK_SCAN_DEPTH && !shouldSkipDirectory(entry)) {
            pending.add(new ScanDirectory(entry, depth));
        }
    }

    private static LinkedRoot toLinkedRoot(Path projectPath) {
        try {
            if (!Files.isDirectory(projectPath) && !Files.isSymbolicLink(projectPath)) {
                return null;
            }

            Path normalizedProjectPath = projectPath.toAbsolutePath().normalize();
            Path realPath = projectPath.toRealPath().normalize();
            // Resolve the parent first: /tmp -> /private/tmp must not make every
            // ordinary child directory look like a link of its own.
            Path entryUnderRealParent = normalizedProjectPath.getParent().toRealPath()
                    .resolve(normalizedProjectPath.getFileName()).normalize();
            if (samePath(entryUnderRealParent, realPath)) {
                return null;
            }

            return new LinkedRoot(normalizedProjectPath, realPath);
        } catch (IOException | SecurityException e) {
            return null;
        }
    }

    private static Path mapByPrefix(Path candidatePath, Path sourcePrefix, Path targetPrefix) {
        if (candidatePath == null || sourcePrefix == null || targetPrefix == null) {
            return null;
        }

        if (!startsWithPath(candidatePath, sourcePrefix)) {
            return null;
        }

        try {
            Path suffix = sourcePrefix.relativize(candidatePath);
            return targetPrefix.resolve(suffix).normalize();
        } catch (IllegalArgumentException e) {
            String suffix = stringSuffix(candidatePath, sourcePrefix);
            if (suffix == null) {
                return null;
            }
            return suffix.isBlank()
                    ? targetPrefix.normalize()
                    : targetPrefix.resolve(suffix.replace('/', File.separatorChar)).normalize();
        }
    }

    private static String relativize(Path root, Path child) {
        try {
            return formatPath(root.relativize(child));
        } catch (IllegalArgumentException e) {
            return stringSuffix(child, root);
        }
    }

    private static String stringSuffix(Path child, Path root) {
        String childText = normalizeForComparison(child);
        String rootText = normalizeForComparison(root);
        if (childText.equals(rootText)) {
            return "";
        }

        String rootWithSlash = rootText.endsWith("/") ? rootText : rootText + "/";
        if (!childText.startsWith(rootWithSlash)) {
            return null;
        }

        return childText.substring(rootWithSlash.length());
    }

    private static boolean startsWithPath(Path child, Path root) {
        if (child.startsWith(root)) {
            return true;
        }

        String childText = normalizeForComparison(child);
        String rootText = normalizeForComparison(root);
        return childText.equals(rootText) || childText.startsWith(rootText + "/");
    }

    private static boolean samePath(Path left, Path right) {
        return normalizeForComparison(left).equals(normalizeForComparison(right));
    }

    private static String normalizeForComparison(Path path) {
        String normalized = formatPath(path);
        if (PlatformUtils.isWindows()) {
            return normalized.toLowerCase(Locale.ROOT);
        }
        return normalized;
    }

    private static String formatPath(Path path) {
        return path.toString().replace('\\', '/');
    }

    private static boolean shouldSkipDirectory(Path dir) {
        Path fileName = dir.getFileName();
        return fileName != null && SKIPPED_DIRECTORY_NAMES.contains(fileName.toString());
    }

    private record LinkedRoot(Path projectPath, Path realPath) {
    }

    private record ScanDirectory(Path path, int depth) {
    }

    private record LinkScanCache(long createdAtMs, List<LinkedRoot> linkedRoots) {
    }
}
