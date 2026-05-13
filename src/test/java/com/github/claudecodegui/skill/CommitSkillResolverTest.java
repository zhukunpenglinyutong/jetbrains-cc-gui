package com.github.claudecodegui.skill;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;

public class CommitSkillResolverTest {

    @Test
    public void shouldRejectTraversalSkillReferences() throws Exception {
        Path root = Files.createTempDirectory("commit-skill-resolver");
        Path allowedSkill = Files.createDirectories(root.resolve("skill"));
        Files.writeString(allowedSkill.resolve("SKILL.md"), "allowed skill");

        assertEquals("allowed skill", CommitSkillResolver.resolveSkillContent("local:" + allowedSkill));
        assertEquals("", CommitSkillResolver.resolveSkillContent("local:../../../etc/passwd"));
        assertEquals("", CommitSkillResolver.resolveSkillContent("../../../etc/passwd"));
    }
}
