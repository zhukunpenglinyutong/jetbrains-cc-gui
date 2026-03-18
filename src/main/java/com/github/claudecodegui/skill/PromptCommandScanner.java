package com.github.claudecodegui.skill;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

final class PromptCommandScanner {

    private PromptCommandScanner() {
    }

    static List<SlashCommandRegistry.SlashCommand> scanPromptsAsCommands(String dirPath) {
        if (dirPath == null || dirPath.isEmpty()) {
            return List.of();
        }
        File dir = new File(dirPath);
        if (!dir.isDirectory()) {
            return List.of();
        }

        File[] entries = dir.listFiles();
        if (entries == null) {
            return List.of();
        }

        List<SlashCommandRegistry.SlashCommand> commands = new ArrayList<>();
        for (File entry : entries) {
            if (!entry.isFile() || !entry.getName().endsWith(".md")
                    || entry.getName().startsWith(".")) {
                continue;
            }
            String baseName = entry.getName().replaceFirst("\\.md$", "");
            String description = SlashCommandJsonReader.extractCommandDescription(entry.toPath());
            commands.add(new SlashCommandRegistry.SlashCommand(
                    "/prompts:" + baseName,
                    description != null ? description : "",
                    "codex-prompt"));
        }
        return commands;
    }
}
