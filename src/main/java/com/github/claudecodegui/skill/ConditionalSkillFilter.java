package com.github.claudecodegui.skill;

import java.nio.file.Path;
import java.util.List;

/**
 * Filters conditional skills by active file path.
 */
public final class ConditionalSkillFilter {

    private ConditionalSkillFilter() {
    }

    /**
     * Returns whether a skill should be shown for the current file.
     *
     * @param metadata parsed skill metadata
     * @param currentFile current file path
     * @return true when skill is visible
     */
    public static boolean filter(SkillFrontmatterParser.SkillMetadata metadata, Path currentFile) {
        if (metadata == null) {
            return false;
        }

        List<String> patterns = metadata.paths();
        if (patterns == null || patterns.isEmpty()) {
            return true;
        }

        return SlashCommandRegistry.matchesPathPatterns(currentFile, patterns);
    }
}
