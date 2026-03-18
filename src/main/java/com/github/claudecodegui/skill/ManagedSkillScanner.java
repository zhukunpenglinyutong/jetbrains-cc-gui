package com.github.claudecodegui.skill;

import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

final class ManagedSkillScanner {

    private static final Logger LOG = Logger.getInstance(ManagedSkillScanner.class);

    private ManagedSkillScanner() {
    }

    static List<SlashCommandRegistry.SlashCommand> scanManagedSkills(String managedDir, String currentFilePath) {
        if (managedDir == null || managedDir.isEmpty()) {
            return List.of();
        }

        Path managedPath = Paths.get(managedDir).toAbsolutePath().normalize();
        if (!SlashCommandPathPolicy.isManagedPathSafe(managedPath)) {
            LOG.warn("Skipping unsafe managed directory: " + managedPath);
            return List.of();
        }

        Path skillsDir = SlashCommandPathPolicy.resolveManagedSkillsDirectory(managedPath);
        if (skillsDir == null) {
            LOG.debug("Managed skills directory not found under: " + managedPath);
            return List.of();
        }

        return SlashCommandRegistry.scanSkillsAsCommands(
                skillsDir.toString(),
                "managed",
                null,
                SlashCommandPathPolicy.toNormalizedPath(currentFilePath)
        );
    }
}
