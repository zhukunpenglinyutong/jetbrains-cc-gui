package com.github.claudecodegui.skill;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.CodexSettingsManager;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.IOException;
import java.nio.file.FileVisitOption;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * Codex Skills service.
 * <p>
 * Manages Codex skill scanning, import, deletion, enabling, and disabling.
 * <p>
 * Codex skills use a different mechanism from Claude:
 * - Directory structure: .agents/skills/ (multi-level upward scanning)
 * - Invocation prefix: $ (not /)
 * - Enable/disable: ~/.codex/config.toml [[skills.config]] entries
 * - Scopes: "user" (~/.agents/skills/) and "repo" ({cwd}/.agents/skills/)
 */
public class CodexSkillService {
    private static final Logger LOG = Logger.getInstance(CodexSkillService.class);
    private static final Gson gson = new Gson();
    private static final int MAX_SCAN_LEVELS = 3;
    private static final int MAX_SKILL_SCAN_DEPTH = 8;
    private static final int MAX_SKILL_SCAN_NODES = 10_000;
    private static final int MAX_DISCOVERED_SKILLS = 1_000;
    private static final Set<String> SKIPPED_SKILL_SCAN_DIRECTORIES = Set.of(
            "node_modules", "build", "target", "dist", "out", "coverage"
    );

    // Shared instance to avoid repeated instantiation (I1)
    private static final CodexSettingsManager codexSettingsManager = new CodexSettingsManager(gson);

    /**
     * Represents a directory to scan for skills, with its scope.
     */
    public record SkillScanDir(String path, String scope) {
    }

    // Pattern to match safe skill names (alphanumeric, hyphens, underscores, dots)
    private static final Pattern SAFE_NAME_PATTERN = Pattern.compile("^[a-zA-Z0-9][a-zA-Z0-9._-]*$");

    // ==================== Utility Methods ====================

    /**
     * Validates that a resolved path is strictly under the given parent directory.
     * Prevents path traversal attacks by normalizing both paths and checking containment.
     */
    private static boolean isPathSafe(Path child, Path parent) {
        Path normalizedChild = child.toAbsolutePath().normalize();
        Path normalizedParent = parent.toAbsolutePath().normalize();
        return normalizedChild.startsWith(normalizedParent) && !normalizedChild.equals(normalizedParent);
    }

    /**
     * Validates a skill name to prevent path traversal via directory names.
     */
    private static boolean isSafeSkillName(String name) {
        if (name == null || name.isEmpty()) { return false; }
        if (name.contains("..") || name.contains("/") || name.contains("\\")) { return false; }
        return SAFE_NAME_PATTERN.matcher(name).matches();
    }

    /**
     * Normalizes a path string for consistent cross-platform comparison.
     * Uses absolute + normalize to handle Windows vs Unix path differences.
     */
    private static String normalizePath(String path) {
        if (path == null || path.isEmpty()) { return path; }
        return Paths.get(path).toAbsolutePath().normalize().toString();
    }

    static boolean isToggleSkillPathAllowed(String skillPath, String cwd) {
        if (skillPath == null || skillPath.isEmpty()) {
            return false;
        }
        try {
            Path candidate = Paths.get(skillPath).toAbsolutePath().normalize();
            Path fileName = candidate.getFileName();
            boolean hasValidFileName = fileName != null
                    && ("SKILL.md".equals(fileName.toString()) || "skill.md".equals(fileName.toString()));
            if (!hasValidFileName || !Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)) {
                return false;
            }

            Path realCandidate = candidate.toRealPath();
            for (SkillScanDir scanDir : getSkillScanDirs(cwd)) {
                Path scanRoot = Paths.get(scanDir.path());
                if (Files.isDirectory(scanRoot) && realCandidate.startsWith(scanRoot.toRealPath())) {
                    return true;
                }
            }
        } catch (Exception e) {
            LOG.warn("[CodexSkills] Failed to validate toggle path: " + e.getMessage());
        }
        return false;
    }

    /**
     * Finds the repository root by walking up from cwd looking for a .git directory.
     *
     * @return the repo root path, or null if not in a git repository
     */
    public static String findRepoRoot(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return null;
        }
        Path current = Paths.get(cwd).toAbsolutePath().normalize();
        Path root = current.getRoot();

        while (current != null && !current.equals(root)) {
            if (Files.isDirectory(current.resolve(".git"))) {
                return current.toString();
            }
            current = current.getParent();
        }
        return null;
    }

    // ==================== Scanning ====================

    /**
     * Gets the list of directories to scan for Codex skills.
     * Scans from CWD upward (max 3 levels), ensures repo root is included,
     * then adds the user-level ~/.agents/skills/ directory.
     */
    public static List<SkillScanDir> getSkillScanDirs(String cwd) {
        List<SkillScanDir> dirs = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        if (cwd != null && !cwd.isEmpty()) {
            String repoRoot = findRepoRoot(cwd);
            Path current = Paths.get(cwd).toAbsolutePath().normalize();
            Path fsRoot = current.getRoot();
            int level = 0;

            while (level < MAX_SCAN_LEVELS && current != null && !current.equals(fsRoot)) {
                String candidate = current.resolve(".agents").resolve("skills").toString();
                String normalizedCandidate = normalizePath(candidate);
                if (Files.isDirectory(Path.of(candidate)) && seen.add(normalizedCandidate)) {
                    dirs.add(new SkillScanDir(candidate, "repo"));
                }
                if (current.toString().equals(repoRoot)) {
                    break;
                }
                current = current.getParent();
                level++;
            }

            // Ensure repo root is scanned even if beyond 3 levels
            if (repoRoot != null) {
                String repoCandidate = Paths.get(repoRoot, ".agents", "skills").toString();
                String normalizedRepo = normalizePath(repoCandidate);
                if (Files.isDirectory(Path.of(repoCandidate)) && seen.add(normalizedRepo)) {
                    dirs.add(new SkillScanDir(repoCandidate, "repo"));
                }
            }
        }

        // User-level directories
        String userHome = NodeDetector.resolveHomeForFileOps();

        // ~/.agents/skills/ (Codex community skills)
        String agentsDir = Paths.get(userHome, ".agents", "skills").toString();
        if (Files.isDirectory(Path.of(agentsDir)) && seen.add(normalizePath(agentsDir))) {
            dirs.add(new SkillScanDir(agentsDir, "user"));
        }

        // ~/.codex/skills/ (Codex CLI installed skills)
        if (isCodexConfigManagementAllowed()) {
            String codexDir = Paths.get(userHome, ".codex", "skills").toString();
            if (Files.isDirectory(Path.of(codexDir)) && seen.add(normalizePath(codexDir))) {
                dirs.add(new SkillScanDir(codexDir, "user"));
            }

            // ~/.codex/skills/.system/ (Codex system-level skills)
            String systemDir = Paths.get(userHome, ".codex", "skills", ".system").toString();
            if (Files.isDirectory(Path.of(systemDir)) && seen.add(normalizePath(systemDir))) {
                dirs.add(new SkillScanDir(systemDir, "user"));
            }
        }

        return dirs;
    }

    /**
     * Scans a directory for skill subdirectories and returns skill metadata as JsonObject.
     */
    public static JsonObject scanSkillsDirectory(String dirPath, String scope) {
        return scanSkillsDirectory(dirPath, scope, MAX_SKILL_SCAN_NODES);
    }

    static JsonObject scanSkillsDirectory(String dirPath, String scope, int maxScanNodes) {
        JsonObject skills = new JsonObject();
        Path rootDir = Paths.get(dirPath).toAbsolutePath().normalize();
        File dir = rootDir.toFile();

        if (!dir.exists() || !dir.isDirectory()) {
            return skills;
        }

        List<File> entries = new ArrayList<>();
        AtomicInteger visitedNodes = new AtomicInteger();
        AtomicBoolean limitReached = new AtomicBoolean(false);
        try {
            Files.walkFileTree(rootDir, EnumSet.noneOf(FileVisitOption.class), MAX_SKILL_SCAN_DEPTH,
                    new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path currentDir, BasicFileAttributes attrs) {
                    if (!currentDir.equals(rootDir) && (containsHiddenPathSegment(rootDir, currentDir)
                            || isSkippedSkillScanDirectory(currentDir))) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    if (visitedNodes.incrementAndGet() > maxScanNodes) {
                        limitReached.set(true);
                        return FileVisitResult.TERMINATE;
                    }
                    if (!currentDir.equals(rootDir) && locateSkillDefinition(currentDir) != null) {
                        if (entries.size() >= MAX_DISCOVERED_SKILLS) {
                            limitReached.set(true);
                            return FileVisitResult.TERMINATE;
                        }
                        entries.add(currentDir.toFile());
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (visitedNodes.incrementAndGet() > maxScanNodes) {
                        limitReached.set(true);
                        return FileVisitResult.TERMINATE;
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    LOG.warn("[CodexSkills] Skipping unreadable path: " + file, e);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            LOG.warn("[CodexSkills] Failed to scan skills directory: " + dirPath, e);
            return skills;
        }
        if (limitReached.get()) {
            LOG.warn("[CodexSkills] Skill scan limit reached: " + dirPath);
        }

        for (File entry : entries.stream().distinct().sorted().toList()) {
            // Use normalized path in id to prevent collisions when same-named skills
            // exist in different scan directories (child vs parent)
            String normalizedEntryPath = normalizePath(entry.getAbsolutePath());
            String id = scope + ":" + normalizedEntryPath;
            JsonObject skill = new JsonObject();
            skill.addProperty("id", id);
            skill.addProperty("type", "directory");
            skill.addProperty("scope", scope);
            skill.addProperty("path", entry.getAbsolutePath());
            skill.addProperty("enabled", true);

            SkillFrontmatterParser.SkillMetadata metadata =
                    SkillFrontmatterParser.parse(entry.toPath());
            if (metadata != null) {
                skill.addProperty("name", metadata.name());
                skill.addProperty("description", metadata.description());
                skill.addProperty("userInvocable", metadata.userInvocable());
            } else {
                skill.addProperty("name", entry.getName());
                skill.addProperty("userInvocable", false);
                skill.addProperty("warning", "invalid_frontmatter");
            }

            // Store skillPath (SKILL.md path) for config.toml operations
            Path skillMd = locateSkillDefinition(entry.toPath());
            if (skillMd != null) {
                skill.addProperty("skillPath", skillMd.toString());
            }

            try {
                BasicFileAttributes attrs = Files.readAttributes(
                        entry.toPath(), BasicFileAttributes.class);
                skill.addProperty("createdAt", attrs.creationTime().toString());
                skill.addProperty("modifiedAt", attrs.lastModifiedTime().toString());
            } catch (IOException e) {
                LOG.warn("[CodexSkills] Failed to read file attributes: " + entry.getAbsolutePath());
            }

            skills.add(id, skill);
        }

        LOG.info("[CodexSkills] Scanned " + skills.size() + " skills from " + scope + ": " + dirPath);
        return skills;
    }

    private static boolean isSkippedSkillScanDirectory(Path directory) {
        Path fileName = directory.getFileName();
        return fileName != null && SKIPPED_SKILL_SCAN_DIRECTORIES.contains(
                fileName.toString().toLowerCase(Locale.ROOT)
        );
    }

    private static Path locateSkillDefinition(Path skillDir) {
        Path upper = skillDir.resolve("SKILL.md");
        if (Files.isRegularFile(upper, LinkOption.NOFOLLOW_LINKS)) {
            return upper;
        }
        Path lower = skillDir.resolve("skill.md");
        return Files.isRegularFile(lower, LinkOption.NOFOLLOW_LINKS) ? lower : null;
    }

    private static boolean containsHiddenPathSegment(Path rootDir, Path skillDir) {
        Path normalizedSkillDir = skillDir.toAbsolutePath().normalize();
        if (!normalizedSkillDir.startsWith(rootDir)) {
            return true;
        }
        Path relative = rootDir.relativize(normalizedSkillDir);
        for (Path segment : relative) {
            if (segment.toString().startsWith(".")) {
                return true;
            }
        }
        return false;
    }

    // ==================== Config.toml Integration ====================

    /**
     * Reads disabled skill paths from ~/.codex/config.toml [[skills.config]] entries.
     *
     * @return set of SKILL.md paths that are disabled
     */
    @SuppressWarnings("unchecked")
    public static Set<String> getDisabledSkillPaths() {
        Set<String> disabled = new HashSet<>();
        if (!isCodexConfigManagementAllowed()) {
            return disabled;
        }
        try {
            Map<String, Object> config = codexSettingsManager.readConfigToml();
            if (config == null) {
                return disabled;
            }

            // Navigate to skills.config (List<Map>)
            Object skillsObj = config.get("skills");
            if (!(skillsObj instanceof Map)) {
                return disabled;
            }
            Map<String, Object> skillsMap = (Map<String, Object>) skillsObj;
            Object configObj = skillsMap.get("config");
            if (!(configObj instanceof List)) {
                return disabled;
            }

            List<Map<String, Object>> configList = (List<Map<String, Object>>) configObj;
            for (Map<String, Object> entry : configList) {
                Object enabledVal = entry.get("enabled");
                Object pathVal = entry.get("path");
                if (pathVal instanceof String && Boolean.FALSE.equals(enabledVal)) {
                    disabled.add(normalizePath((String) pathVal));
                }
            }
        } catch (Exception e) {
            LOG.warn("[CodexSkills] Failed to read disabled skills from config.toml: " + e.getMessage());
        }
        return disabled;
    }

    /**
     * Gets all Codex skills (user + repo scopes), with enabled state from config.toml.
     *
     * @return JsonObject with "user" and "repo" keys
     */
    public static JsonObject getAllSkills(String cwd) {
        JsonObject userSkills = new JsonObject();
        JsonObject repoSkills = new JsonObject();
        Set<String> disabledPaths = getDisabledSkillPaths();

        // Track seen entry names per scope for first-hit-wins dedup.
        // Scan order is child→parent, so child directory skills take priority.
        Set<String> seenUserNames = new HashSet<>();
        Set<String> seenRepoNames = new HashSet<>();

        List<SkillScanDir> scanDirs = getSkillScanDirs(cwd);
        for (SkillScanDir scanDir : scanDirs) {
            JsonObject scanned = scanSkillsDirectory(scanDir.path(), scanDir.scope());

            // Mark disabled skills and merge into appropriate scope bucket
            for (String key : scanned.keySet()) {
                JsonObject skill = scanned.getAsJsonObject(key);

                // Extract directory name from path for dedup
                String entryPath = skill.has("path") ? skill.get("path").getAsString() : null;
                String entryName = entryPath != null ? new File(entryPath).getName() : key;

                String skillPath = skill.has("skillPath") ? skill.get("skillPath").getAsString() : null;
                if (skillPath != null && disabledPaths.contains(normalizePath(skillPath))) {
                    skill.addProperty("enabled", false);
                }

                if ("user".equals(scanDir.scope())) {
                    // First-hit wins: skip if a same-named skill was already added
                    if (seenUserNames.add(entryName)) {
                        userSkills.add(key, skill);
                    } else {
                        LOG.info("[CodexSkills] Skipping duplicate user skill '" + entryName + "' from: " + entryPath);
                    }
                } else {
                    if (seenRepoNames.add(entryName)) {
                        repoSkills.add(key, skill);
                    } else {
                        LOG.info("[CodexSkills] Skipping duplicate repo skill '" + entryName + "' from: " + entryPath);
                    }
                }
            }
        }

        JsonObject result = new JsonObject();
        result.add("user", userSkills);
        result.add("repo", repoSkills);
        return result;
    }

    // ==================== Toggle (config.toml) ====================

    /**
     * Toggles a Codex skill's enabled state via config.toml.
     * Disable: adds a [[skills.config]] entry with enabled=false.
     * Enable: removes the corresponding [[skills.config]] entry.
     */
    @SuppressWarnings("unchecked")
    public static JsonObject toggleSkill(String skillPath, boolean currentEnabled, String cwd) {
        JsonObject result = new JsonObject();

        if (!isCodexConfigManagementAllowed()) {
            result.addProperty("success", false);
            result.addProperty("error", com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.codexLocalAccessNotAuthorized"));
            return result;
        }

        if (skillPath == null || skillPath.isEmpty()) {
            result.addProperty("success", false);
            result.addProperty("error", "Skill path is required for toggle operation");
            return result;
        }

        if (!isToggleSkillPathAllowed(skillPath, cwd)) {
            result.addProperty("success", false);
            result.addProperty("error", "Skill path must point to an existing SKILL.md inside a configured skills directory");
            return result;
        }

        // Normalize path before any comparison or write to ensure cross-platform consistency
        String normalizedSkillPath = normalizePath(skillPath);

        try {
            codexSettingsManager.updateConfigToml(CodexSkillService::isCodexConfigManagementAllowed, config -> {
                // Navigate to skills -> config list
                Map<String, Object> skillsMap = (Map<String, Object>) config
                        .computeIfAbsent("skills", k -> new LinkedHashMap<String, Object>());
                List<Map<String, Object>> configList = (List<Map<String, Object>>) skillsMap
                        .computeIfAbsent("config", k -> new ArrayList<Map<String, Object>>());

                if (currentEnabled) {
                    // Disable: remove any existing entry first (idempotent), then add
                    configList.removeIf(entry -> {
                        Object pathVal = entry.get("path");
                        return pathVal instanceof String && normalizedSkillPath.equals(normalizePath((String) pathVal));
                    });
                    Map<String, Object> entry = new LinkedHashMap<>();
                    entry.put("path", normalizedSkillPath);
                    entry.put("enabled", false);
                    configList.add(entry);
                    result.addProperty("enabled", false);
                } else {
                    // Enable: remove matching entry
                    configList.removeIf(entry -> {
                        Object pathVal = entry.get("path");
                        return pathVal instanceof String && normalizedSkillPath.equals(normalizePath((String) pathVal));
                    });
                    result.addProperty("enabled", true);
                }
                return true;
            });
            result.addProperty("success", true);
            LOG.info("[CodexSkills] Toggled skill: " + normalizedSkillPath + " -> enabled=" + !currentEnabled);
        } catch (Exception e) {
            result.addProperty("success", false);
            result.addProperty("error", "Toggle failed: " + e.getMessage());
            LOG.error("[CodexSkills] Toggle failed: " + e.getMessage(), e);
        }
        return result;
    }

    // ==================== Import ====================

    /**
     * Imports skills to the specified scope directory.
     * scope="user" → ~/.agents/skills/, scope="repo" → {cwd}/.agents/skills/
     */
    public static JsonObject importSkill(List<String> sourcePaths, String scope, String cwd) {
        JsonObject result = new JsonObject();
        JsonArray imported = new JsonArray();
        JsonArray errors = new JsonArray();

        String targetDir;
        if ("user".equals(scope)) {
            targetDir = Paths.get(NodeDetector.resolveHomeForFileOps(), ".agents", "skills").toString();
        } else {
            if (cwd == null || cwd.isEmpty()) {
                result.addProperty("success", false);
                result.addProperty("error", "No working directory for repo scope");
                return result;
            }
            targetDir = Paths.get(cwd, ".agents", "skills").toString();
        }

        // Ensure target directory exists
        File targetDirFile = new File(targetDir);
        if (!targetDirFile.exists() && !targetDirFile.mkdirs()) {
            result.addProperty("success", false);
            result.addProperty("error", "Cannot create directory: " + targetDir);
            return result;
        }

        for (String sourcePath : sourcePaths) {
            File source = new File(sourcePath);
            if (!source.exists()) {
                JsonObject err = new JsonObject();
                err.addProperty("path", sourcePath);
                err.addProperty("error", "Source path does not exist");
                errors.add(err);
                continue;
            }

            String name = source.getName();

            // Codex skills must be directories containing SKILL.md; reject plain files
            if (!source.isDirectory()) {
                JsonObject err = new JsonObject();
                err.addProperty("path", sourcePath);
                err.addProperty("error", "Codex skill must be a directory containing SKILL.md");
                errors.add(err);
                continue;
            }

            // Validate name to prevent path traversal
            if (!isSafeSkillName(name)) {
                JsonObject err = new JsonObject();
                err.addProperty("path", sourcePath);
                err.addProperty("error", "Invalid skill name: " + name);
                errors.add(err);
                continue;
            }

            File targetPath = new File(targetDir, name);

            // Verify target resolves inside the target directory
            if (!isPathSafe(targetPath.toPath(), Path.of(targetDir))) {
                JsonObject err = new JsonObject();
                err.addProperty("path", sourcePath);
                err.addProperty("error", "Target path escapes skills directory");
                errors.add(err);
                continue;
            }

            if (targetPath.exists()) {
                JsonObject err = new JsonObject();
                err.addProperty("path", sourcePath);
                err.addProperty("error", "Skill already exists: " + name);
                errors.add(err);
                continue;
            }

            try {
                copyDirectory(source.toPath(), targetPath.toPath());

                JsonObject skill = new JsonObject();
                skill.addProperty("id", scope + ":" + normalizePath(targetPath.getAbsolutePath()));
                skill.addProperty("name", name);
                skill.addProperty("scope", scope);
                skill.addProperty("path", targetPath.getAbsolutePath());
                imported.add(skill);
                LOG.info("[CodexSkills] Imported skill: " + name + " to " + scope);
            } catch (IOException e) {
                JsonObject err = new JsonObject();
                err.addProperty("path", sourcePath);
                err.addProperty("error", "Copy failed: " + e.getMessage());
                errors.add(err);
            }
        }

        result.addProperty("success", imported.size() > 0);
        result.addProperty("count", imported.size());
        result.add("imported", imported);
        if (errors.size() > 0) {
            result.add("errors", errors);
        }
        return result;
    }

    // ==================== Delete ====================

    /**
     * Deletes a Codex skill directory and cleans up any config.toml disable entry.
     */
    @SuppressWarnings("unchecked")
    public static JsonObject deleteSkill(String name, String scope, String skillPath, String cwd) {
        JsonObject result = new JsonObject();

        // Determine the skill directory from skillPath (parent of SKILL.md)
        File skillDir;
        if (skillPath != null && !skillPath.isEmpty()) {
            // Validate skillPath: must end with SKILL.md or skill.md
            Path normalizedSkillPath = Paths.get(skillPath).toAbsolutePath().normalize();
            String fileName = normalizedSkillPath.getFileName().toString();
            if (!"SKILL.md".equals(fileName) && !"skill.md".equals(fileName)) {
                result.addProperty("success", false);
                result.addProperty("error", "Skill path must point to a SKILL.md file");
                return result;
            }
            File parentDir = normalizedSkillPath.getParent().toFile();
            // Verify parent directory name matches skill name for consistency
            if (name != null && !name.isEmpty() && !parentDir.getName().equals(name)) {
                result.addProperty("success", false);
                result.addProperty("error", "Skill path does not match skill name");
                return result;
            }
            skillDir = parentDir;
        } else {
            // Fallback: construct from scope and name
            // Validate name to prevent path traversal
            if (!isSafeSkillName(name)) {
                result.addProperty("success", false);
                result.addProperty("error", "Invalid skill name: " + name);
                return result;
            }
            String baseDir;
            if ("user".equals(scope)) {
                baseDir = Paths.get(NodeDetector.resolveHomeForFileOps(), ".agents", "skills").toString();
            } else {
                if (cwd == null || cwd.isEmpty()) {
                    result.addProperty("success", false);
                    result.addProperty("error", "Working directory is required for repo scope deletion");
                    return result;
                }
                baseDir = Paths.get(cwd, ".agents", "skills").toString();
            }
            skillDir = new File(baseDir, name);
        }

        if (!skillDir.exists()) {
            result.addProperty("success", false);
            result.addProperty("error", "Skill directory does not exist");
            return result;
        }

        // Security: verify the skill directory is inside a legitimate skills directory
        // Collect all valid skills base directories
        List<Path> validBaseDirs = new ArrayList<>();
        String userHome = NodeDetector.resolveHomeForFileOps();
        validBaseDirs.add(Paths.get(userHome, ".agents", "skills"));
        validBaseDirs.add(Paths.get(userHome, ".codex", "skills"));
        validBaseDirs.add(Paths.get(userHome, ".codex", "skills", ".system"));
        if (cwd != null && !cwd.isEmpty()) {
            // Scan upward from cwd (consistent with getSkillScanDirs)
            String repoRoot = findRepoRoot(cwd);
            Path current = Paths.get(cwd).toAbsolutePath().normalize();
            Path fsRoot = current.getRoot();
            int level = 0;
            while (level < MAX_SCAN_LEVELS && current != null && !current.equals(fsRoot)) {
                validBaseDirs.add(current.resolve(".agents").resolve("skills"));
                if (current.toString().equals(repoRoot)) {
                    break;
                }
                current = current.getParent();
                level++;
            }
            // Ensure repo root is included even if beyond MAX_SCAN_LEVELS
            if (repoRoot != null) {
                validBaseDirs.add(Paths.get(repoRoot, ".agents", "skills"));
            }
        }

        Path normalizedSkillDir = skillDir.toPath().toAbsolutePath().normalize();
        boolean isInsideValidDir = validBaseDirs.stream()
                                           .anyMatch(base -> isPathSafe(normalizedSkillDir, base));
        if (!isInsideValidDir) {
            result.addProperty("success", false);
            result.addProperty("error", "Skill directory is not inside a valid skills directory");
            LOG.warn("[CodexSkills] Blocked deletion of path outside skills directories: " + normalizedSkillDir);
            return result;
        }

        Path codexSkillsDir = Paths.get(userHome, ".codex", "skills").toAbsolutePath().normalize();
        boolean isCodexManagedSkill = isPathSafe(normalizedSkillDir, codexSkillsDir);

        try {
            if (isCodexManagedSkill) {
                codexSettingsManager.runWithConfigAccess(
                        CodexSkillService::isCodexConfigManagementAllowed,
                        () -> deleteSkillDirectory(skillDir));
            } else {
                deleteSkillDirectory(skillDir);
            }
        } catch (IOException e) {
            result.addProperty("success", false);
            if (isCodexManagedSkill && !isCodexConfigManagementAllowed()) {
                result.addProperty("error", com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message(
                        "error.codexLocalAccessNotAuthorized"));
            } else {
                result.addProperty("error", "Delete failed: " + e.getMessage());
            }
            return result;
        }

        // Clean up config.toml disable entry if present
        if (skillPath != null) {
            cleanupConfigTomlEntry(skillPath);
        }

        result.addProperty("success", true);
        return result;
    }

    /**
     * Removes a skill's disable entry from config.toml (if it exists).
     */
    @SuppressWarnings("unchecked")
    private static void cleanupConfigTomlEntry(String skillPath) {
        if (!isCodexConfigManagementAllowed()) {
            return;
        }
        try {
            // Normalize for consistent cross-platform comparison
            String normalizedSkillPath = normalizePath(skillPath);
            codexSettingsManager.updateConfigToml(CodexSkillService::isCodexConfigManagementAllowed, config -> {
                Object skillsObj = config.get("skills");
                if (!(skillsObj instanceof Map)) { return false; }

                Map<String, Object> skillsMap = (Map<String, Object>) skillsObj;
                Object configObj = skillsMap.get("config");
                if (!(configObj instanceof List)) { return false; }

                List<Map<String, Object>> configList = (List<Map<String, Object>>) configObj;
                boolean removed = configList.removeIf(e -> {
                    Object pathVal = e.get("path");
                    return pathVal instanceof String && normalizedSkillPath.equals(normalizePath((String) pathVal));
                });
                if (removed) {
                    LOG.info("[CodexSkills] Cleaned up config.toml entry for: " + skillPath);
                }
                return removed;
            });
        } catch (Exception e) {
            LOG.warn("[CodexSkills] Failed to cleanup config.toml: " + e.getMessage());
        }
    }

    // ==================== File Helpers ====================

    private static void copyDirectory(Path source, Path target) throws IOException {
        Path normalizedTarget = target.toAbsolutePath().normalize();
        Files.walkFileTree(source, EnumSet.noneOf(FileVisitOption.class), Integer.MAX_VALUE, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                if (Files.isSymbolicLink(dir) && !dir.equals(source)) {
                    LOG.warn("[CodexSkills] Skipping symbolic link directory during copy: " + dir);
                    return FileVisitResult.SKIP_SUBTREE;
                }
                Path resolvedTarget = normalizedTarget.resolve(source.relativize(dir)).normalize();
                if (!resolvedTarget.startsWith(normalizedTarget)) {
                    LOG.warn("[CodexSkills] Path traversal detected during copy, skipping: " + dir);
                    return FileVisitResult.SKIP_SUBTREE;
                }
                Files.createDirectories(resolvedTarget);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (Files.isSymbolicLink(file)) {
                    LOG.warn("[CodexSkills] Skipping symbolic link file during copy: " + file);
                    return FileVisitResult.CONTINUE;
                }
                Path resolvedTarget = normalizedTarget.resolve(source.relativize(file)).normalize();
                if (!resolvedTarget.startsWith(normalizedTarget)) {
                    LOG.warn("[CodexSkills] Path traversal detected during copy, skipping: " + file);
                    return FileVisitResult.CONTINUE;
                }
                Files.copy(file, resolvedTarget, StandardCopyOption.REPLACE_EXISTING);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException exc) {
                LOG.warn("[CodexSkills] Failed to visit file during copy: " + file);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static boolean isCodexConfigManagementAllowed() {
        try {
            return new CodemossSettingsService().isCodexConfigManagementAllowed();
        } catch (Exception e) {
            LOG.warn("[CodexSkills] Failed to read Codex config management state: " + e.getMessage());
            return false;
        }
    }

    private static void deleteSkillDirectory(File skillDir) throws IOException {
        // Delete a directory symlink itself, never the target it references.
        if (Files.isSymbolicLink(skillDir.toPath())) {
            Files.delete(skillDir.toPath());
            LOG.info("[CodexSkills] Deleted symbolic link skill: " + skillDir);
        } else {
            deleteDirectory(skillDir.toPath());
            LOG.info("[CodexSkills] Deleted skill directory: " + skillDir);
        }
    }

    private static void deleteDirectory(Path dir) throws IOException {
        Path normalizedDir = dir.toAbsolutePath().normalize();
        Files.walkFileTree(dir, EnumSet.noneOf(FileVisitOption.class), Integer.MAX_VALUE, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (!file.toAbsolutePath().normalize().startsWith(normalizedDir)) {
                    LOG.warn("[CodexSkills] Skipping file outside target directory during delete: " + file);
                    return FileVisitResult.CONTINUE;
                }
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path d, IOException exc) throws IOException {
                if (!d.toAbsolutePath().normalize().startsWith(normalizedDir)) {
                    return FileVisitResult.CONTINUE;
                }
                Files.delete(d);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException exc) {
                LOG.warn("[CodexSkills] Failed to visit file during delete: " + file);
                return FileVisitResult.CONTINUE;
            }
        });
    }
}
