package com.github.claudecodegui.skill;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class CodexSkillServicePathTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void gitfileStopsAtNearestWorktreeOrSubmoduleBoundary() throws Exception {
        Path outer = temporary.getRoot().toPath();
        Files.createDirectory(outer.resolve(".git"));
        Path linked = Files.createDirectory(outer.resolve("linked"));
        Files.writeString(linked.resolve(".git"), "gitdir: ../.git/worktrees/linked\n");
        Path cwd = Files.createDirectories(linked.resolve("a/b/c/d"));
        Path skill = createSkill(linked, "linked-root");
        Path outside = createSkill(outer, "outside");

        assertEquals(linked.toRealPath().toString(), CodexSkillService.findRepoRoot(cwd.toString()));
        assertTrue(CodexSkillService.isToggleSkillPathAllowed(skill.toString(), cwd.toString()));
        assertFalse(CodexSkillService.isToggleSkillPathAllowed(outside.toString(), cwd.toString()));
    }

    @Test public void allAncestorsThroughRepositoryRootAreManageable() throws Exception {
        Path repo = temporary.getRoot().toPath();
        Files.createDirectory(repo.resolve(".git"));
        Path intermediate = Files.createDirectory(repo.resolve("modules"));
        Path cwd = Files.createDirectories(intermediate.resolve("a/b/c/d/e"));
        for (Path directory : List.of(repo, intermediate, cwd)) {
            Path skill = createSkill(directory, "example");
            assertTrue(directory.toString(), CodexSkillService.isToggleSkillPathAllowed(skill.toString(), cwd.toString()));
        }
    }

    @Test public void outsideRepositoryOnlyCurrentDirectorySkillsAreManageable() throws Exception {
        Path parent = temporary.getRoot().toPath();
        Path cwd = Files.createDirectories(parent.resolve("a/b/c/d"));
        Path parentSkill = createSkill(parent, "parent");
        Path currentSkill = createSkill(cwd, "current");

        assertNull(CodexSkillService.findRepoRoot(cwd.toString()));
        assertTrue(CodexSkillService.isToggleSkillPathAllowed(currentSkill.toString(), cwd.toString()));
        assertFalse(CodexSkillService.isToggleSkillPathAllowed(parentSkill.toString(), cwd.toString()));
    }

    private Path createSkill(Path directory, String name) throws Exception {
        Path skillDir = Files.createDirectories(directory.resolve(".agents/skills").resolve(name));
        return Files.writeString(skillDir.resolve("SKILL.md"), "---\nname: " + name + "\ndescription: Test skill\n---\n");
    }

    @Test public void enablingRealSkillRemovesAllJunctionAndRealPathOverrides() throws Exception {
        Path root = temporary.getRoot().toPath();
        Path real = Files.createDirectories(root.resolve("real-skills"));
        Path selected = Files.writeString(real.resolve("SKILL.md"), "---\nname: imagegen\n---\n");
        Path alias = root.resolve("linked-skills");
        if (System.getProperty("os.name", "").startsWith("Windows")) {
            Process junction = new ProcessBuilder("cmd.exe", "/c", "mklink", "/J", alias.toString(), real.toString()).start();
            assertTrue(junction.waitFor(10, TimeUnit.SECONDS));
            assertEquals(0, junction.exitValue());
        } else {
            Files.createSymbolicLink(alias, real);
        }
        List<Map<String, Object>> overrides = new ArrayList<>();
        overrides.add(new LinkedHashMap<>(Map.of("path", alias.resolve("SKILL.md").toString(), "enabled", false)));
        overrides.add(new LinkedHashMap<>(Map.of("path", selected.toString(), "enabled", false)));
        overrides.add(new LinkedHashMap<>(Map.of("path", real.resolve("OTHER.md").toString(), "enabled", false)));
        try {
            CodexSkillService.removeSkillOverrides(overrides, selected.toString());
            assertEquals(1, overrides.size());
            assertTrue(overrides.get(0).get("path").toString().endsWith("OTHER.md"));
            assertTrue(Files.exists(selected));
        } finally {
            Files.delete(alias);
        }
    }
}
