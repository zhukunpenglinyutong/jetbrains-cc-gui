package com.github.claudecodegui.cli;

import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.dependency.SdkDefinition;
import org.junit.Test;

import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Guards CLI discovery while keeping legacy installations outside SDK management. */
public class CliStatusDetectorCodexTest {
    @Test
    public void codexIsACliAndCannotBeManagedAsAnSdk() {
        assertEquals(CliToolId.CODEX, CliToolId.fromId("codex"));
        assertNull(SdkDefinition.fromId("codex-sdk"));
        assertNull(SdkDefinition.fromProvider("codex"));
        assertFalse(new DependencyManager().isInstalled("codex-sdk"));
    }

    @Test
    public void preservesOfficialHoistedNestedAndLegacyVendorLayouts() {
        Path root = Path.of("fixture/node_modules");
        var candidates = CliStatusDetector.codexLegacyCandidates(root, "win32", "amd64");
        assertTrue(candidates.contains(root.resolve("@openai/codex/node_modules/@openai/codex-win32-x64"
                + "/vendor/x86_64-pc-windows-msvc/codex/codex.exe")));
        assertTrue(candidates.contains(root.resolve("@openai/codex-sdk/node_modules/@openai/codex-win32-x64"
                + "/vendor/x86_64-pc-windows-msvc/bin/codex.exe")));
        assertTrue(candidates.contains(root.resolve("@openai/codex-sdk/vendor/x86_64-pc-windows-msvc/codex/codex.exe")));
    }

    @Test
    public void sdkMetadataIsNeverACliCandidateAndArmUsesItsOwnBinary() {
        var candidates = CliStatusDetector.codexLegacyCandidates(Path.of("fixture/node_modules"), "darwin", "aarch64");
        assertTrue(candidates.stream().anyMatch(path -> path.toString().replace('\\', '/')
                .endsWith("codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex")));
        assertFalse(candidates.stream().anyMatch(path -> path.toString().endsWith("package.json")
                || path.toString().endsWith(".installed")));
    }
}
