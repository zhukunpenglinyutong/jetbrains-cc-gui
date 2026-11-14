package com.github.claudecodegui.skill;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * A plugin manifest may declare each skill directory individually
 * ("skills": ["./skills/a", "./skills/b"]) instead of one parent "skills" directory.
 * Both shapes must yield slash commands.
 */
public class SkillDirScanTest {

    @Rule
    public final TemporaryFolder tmp = new TemporaryFolder();

    private static void writeSkill(Path dir, String name) throws Exception {
        Files.createDirectories(dir);
        String md = "---\nname: " + name + "\ndescription: " + name + " skill\n---\n\nbody\n";
        Files.write(dir.resolve("SKILL.md"), md.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void declaredSkillDirectoryItselfIsScanned() throws Exception {
        Path root = tmp.newFolder("ccgui-skill").toPath();
        Path skill = root.resolve("ask-matt");
        writeSkill(skill, "ask-matt");

        List<SlashCommandRegistry.SlashCommand> cmds = SlashCommandRegistry.scanSkillsAsCommands(
                skill.toString(), "plugin", "mattpocock-skills", null);

        assertEquals(1, cmds.size());
        assertEquals("/mattpocock-skills:ask-matt", cmds.get(0).name());
    }

    @Test
    public void parentSkillsDirectoryStillScansChildren() throws Exception {
        Path root = tmp.newFolder("ccgui-skills").toPath();
        writeSkill(root.resolve("ask-matt"), "ask-matt");
        writeSkill(root.resolve("tdd"), "tdd");

        List<SlashCommandRegistry.SlashCommand> cmds = SlashCommandRegistry.scanSkillsAsCommands(
                root.toString(), "plugin", "mattpocock-skills", null);

        assertEquals(2, cmds.size());
        assertTrue(cmds.stream().anyMatch(c -> c.name().equals("/mattpocock-skills:tdd")));
    }

    @Test
    public void rootSkillPlusChildSkillsYieldsBoth() throws Exception {
        Path root = tmp.newFolder("ccgui-mixed").toPath();
        writeSkill(root, "root-skill");
        writeSkill(root.resolve("child-skill"), "child-skill");

        List<SlashCommandRegistry.SlashCommand> cmds = SlashCommandRegistry.scanSkillsAsCommands(
                root.toString(), "user", null, null);

        assertEquals(2, cmds.size());
        assertTrue(cmds.stream().anyMatch(c -> c.name().equals("/root-skill")));
        assertTrue(cmds.stream().anyMatch(c -> c.name().equals("/child-skill")));
    }

    @Test
    public void plainDirectoryWithNoSkillYieldsNothing() throws Exception {
        Path root = tmp.newFolder("ccgui-empty").toPath();
        Files.createDirectory(root.resolve("assets"));

        assertTrue(SlashCommandRegistry.scanSkillsAsCommands(
                root.toString(), "plugin", "ns", null).isEmpty());
    }
}
