package com.github.claudecodegui.skill;

import com.intellij.openapi.diagnostic.Logger;
import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Parses SKILL.md YAML frontmatter per the Agent Skills specification.
 * Extracts and validates name, description, and optional metadata fields.
 */
public final class SkillFrontmatterParser {

    private static final Logger LOG = Logger.getInstance(SkillFrontmatterParser.class);

    // Name validation: lowercase alphanumeric + hyphens, 1-64 chars,
    // no leading/trailing hyphen, no consecutive hyphens
    private static final Pattern NAME_PATTERN =
            Pattern.compile("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$");
    private static final int NAME_MAX_LENGTH = 64;
    private static final int DESCRIPTION_MAX_LENGTH = 1024;
    private static final Pattern CONSECUTIVE_HYPHENS = Pattern.compile("--");

    private SkillFrontmatterParser() {
    }

    /**
     * Parsed skill metadata from SKILL.md frontmatter.
     */
    public record SkillMetadata(
            String name,
            String description,
            String license,
            String compatibility,
            String allowedTools,
            boolean userInvocable
    ) {
    }

    /**
     * Validates a skill name per the Agent Skills specification.
     */
    public static boolean isValidSkillName(String name) {
        if (name == null || name.isEmpty() || name.length() > NAME_MAX_LENGTH) {
            return false;
        }
        if (CONSECUTIVE_HYPHENS.matcher(name).find()) {
            return false;
        }
        return NAME_PATTERN.matcher(name).matches();
    }

    /**
     * Locates the SKILL.md file in a skill directory.
     * Checks SKILL.md first, then skill.md as fallback.
     *
     * @return the path to the skill markdown file, or null if not found
     */
    static Path locateSkillMd(Path skillDir) {
        Path upper = skillDir.resolve("SKILL.md");
        if (Files.isRegularFile(upper)) {
            return upper;
        }
        Path lower = skillDir.resolve("skill.md");
        if (Files.isRegularFile(lower)) {
            return lower;
        }
        return null;
    }

    /**
     * Extracts YAML frontmatter text between the first pair of --- delimiters.
     *
     * @return the YAML text, or null if no valid frontmatter found
     */
    static String extractFrontmatter(Path filePath) {
        String content;
        try {
            content = Files.readString(filePath, StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOG.warn("Failed to read skill file: " + filePath, e);
            return null;
        }

        if (!content.startsWith("---")) {
            LOG.debug("No frontmatter delimiter at start of file: " + filePath);
            return null;
        }

        // Find the closing --- delimiter (skip the opening one)
        int secondDelimiter = content.indexOf("\n---", 3);
        if (secondDelimiter < 0) {
            LOG.debug("No closing frontmatter delimiter in file: " + filePath);
            return null;
        }

        // Extract YAML between the two delimiters
        String yaml = content.substring(3, secondDelimiter).trim();
        if (yaml.isEmpty()) {
            LOG.debug("Empty frontmatter in file: " + filePath);
            return null;
        }
        return yaml;
    }

    /**
     * Parses a skill directory's SKILL.md frontmatter into validated metadata.
     * Combines file location, frontmatter extraction, YAML parsing, and validation.
     *
     * @param skillDir the skill directory (e.g. ~/.claude/skills/commit/)
     * @return parsed and validated metadata, or null if parsing/validation fails
     */
    @SuppressWarnings("unchecked")
    public static SkillMetadata parse(Path skillDir) {
        // Step 1: Locate SKILL.md
        Path skillMd = locateSkillMd(skillDir);
        if (skillMd == null) {
            return null;
        }

        // Step 2: Extract frontmatter YAML text
        String yamlText = extractFrontmatter(skillMd);
        if (yamlText == null) {
            return null;
        }

        // Step 3: Parse YAML
        Map<String, Object> yamlMap;
        try {
            LoadSettings settings = LoadSettings.builder().build();
            Load load = new Load(settings);
            Object parsed = load.loadFromString(yamlText);
            if (!(parsed instanceof Map)) {
                LOG.warn("Frontmatter is not a YAML mapping: " + skillMd);
                return null;
            }
            yamlMap = (Map<String, Object>) parsed;
        } catch (Exception e) {
            LOG.warn("Failed to parse YAML frontmatter in " + skillMd + ": " + e.getMessage());
            return null;
        }

        // Step 4: Extract name (optional per docs, falls back to directory name)
        String dirName = skillDir.getFileName().toString();
        Object nameObj = yamlMap.get("name");
        String name;
        if (nameObj != null) {
            name = String.valueOf(nameObj).trim();
            if (!isValidSkillName(name)) {
                LOG.warn("Invalid skill name '" + name + "' in " + skillMd
                        + ", falling back to directory name '" + dirName + "'");
                name = dirName;
            }
        } else {
            name = dirName;
        }

        // Step 5: Extract description (optional per docs, falls back to first paragraph)
        Object descObj = yamlMap.get("description");
        String description = descObj != null ? String.valueOf(descObj).trim() : null;
        if (description == null || description.isEmpty()) {
            description = extractFirstParagraph(skillMd);
            if (description != null) {
                LOG.debug("Using first paragraph as description for: " + skillMd);
            }
        }
        if (description == null) {
            description = "";
        }
        if (description.length() > DESCRIPTION_MAX_LENGTH) {
            description = description.substring(0, DESCRIPTION_MAX_LENGTH);
        }

        // Step 6: Extract optional fields
        String license = getOptionalString(yamlMap, "license");
        String compatibility = getOptionalString(yamlMap, "compatibility");
        String allowedTools = getOptionalString(yamlMap, "allowed-tools");

        // Step 7: Extract user-invocable (default true per docs)
        boolean userInvocable = true;
        Object uiObj = yamlMap.get("user-invocable");
        if (uiObj != null) {
            userInvocable = Boolean.parseBoolean(String.valueOf(uiObj).trim());
        }

        return new SkillMetadata(name, description, license, compatibility, allowedTools, userInvocable);
    }

    /**
     * Convenience method for SkillService backward compatibility.
     * Extracts only the description field from a skill directory's SKILL.md.
     *
     * @param skillDir the skill directory path
     * @return the description string, or null if parsing fails
     */
    public static String extractDescription(Path skillDir) {
        SkillMetadata metadata = parse(skillDir);
        return metadata != null ? metadata.description() : null;
    }

    /**
     * Extracts the first non-empty paragraph from the markdown body after frontmatter.
     * Used as fallback when the description field is missing from frontmatter.
     */
    static String extractFirstParagraph(Path filePath) {
        String content;
        try {
            content = Files.readString(filePath, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }

        // Find the end of frontmatter
        if (!content.startsWith("---")) {
            return null;
        }
        int closingDelimiter = content.indexOf("\n---", 3);
        if (closingDelimiter < 0) {
            return null;
        }

        // Skip past the closing --- and any trailing newline
        int bodyStart = content.indexOf('\n', closingDelimiter + 4);
        if (bodyStart < 0 || bodyStart >= content.length()) {
            return null;
        }
        String body = content.substring(bodyStart + 1).stripLeading();
        if (body.isEmpty()) {
            return null;
        }

        // Take text up to the first blank line (double newline)
        int blankLine = body.indexOf("\n\n");
        String firstParagraph = (blankLine > 0 ? body.substring(0, blankLine) : body).trim();

        // Strip leading markdown heading markers (# ## etc.)
        firstParagraph = firstParagraph.replaceFirst("^#+\\s*", "");

        if (firstParagraph.isEmpty() || firstParagraph.length() > DESCRIPTION_MAX_LENGTH) {
            return firstParagraph.isEmpty() ? null
                    : firstParagraph.substring(0, DESCRIPTION_MAX_LENGTH);
        }
        return firstParagraph;
    }

    private static String getOptionalString(Map<String, Object> map, String key) {
        Object value = map.get(key);
        if (value == null) {
            return null;
        }
        String str = String.valueOf(value).trim();
        return str.isEmpty() ? null : str;
    }
}
