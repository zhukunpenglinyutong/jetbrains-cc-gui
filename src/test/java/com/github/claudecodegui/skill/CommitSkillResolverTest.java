package com.github.claudecodegui.skill;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;

public class CommitSkillResolverTest {

    @Test
    public void shouldRejectTraversalSkillReferences() throws Exception {
        Path root = Files.createTempDirectory("commit-skill-resolver");
        Path allowedSkill = Files.createDirectories(root.resolve(".codex").resolve("skills").resolve("skill"));
        Path untrustedSkill = Files.createDirectories(root.resolve("outside").resolve("skill"));
        Files.writeString(allowedSkill.resolve("SKILL.md"), "allowed skill");
        Files.writeString(untrustedSkill.resolve("SKILL.md"), "untrusted skill");
        String builtinSkill = CommitSkillResolver.resolveSkillContent(null);

        assertEquals("allowed skill", CommitSkillResolver.resolveSkillContent(
                "local:" + allowedSkill,
                root.toString()
        ));
        assertEquals("allowed skill", CommitSkillResolver.resolveSkillContent(
                allowedSkill.toString(),
                root.toString()
        ));
        assertEquals(builtinSkill, CommitSkillResolver.resolveSkillContent(
                "local:" + untrustedSkill,
                root.toString()
        ));
        assertEquals(builtinSkill, CommitSkillResolver.resolveSkillContent(
                untrustedSkill.toString(),
                root.toString()
        ));
        assertEquals(builtinSkill, CommitSkillResolver.resolveSkillContent(
                "local:../../../etc/passwd",
                root.toString()
        ));
        assertEquals(builtinSkill, CommitSkillResolver.resolveSkillContent(
                "../../../etc/passwd",
                root.toString()
        ));
    }
}
