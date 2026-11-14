package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.WslPathUtil;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.util.function.Predicate;
import java.util.function.UnaryOperator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeProjectTrustParamsTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final UnaryOperator<String> NO_CONVERSION = cwd -> cwd;

    private static JsonObject sendParams(ClaudeRequestParamsBuilder builder, boolean projectTrusted) {
        return builder.buildSendParams("hi", "", "", "/work", "default", "", null, null, null, null, null, null, false, projectTrusted);
    }

    private static ClaudeRequestParamsBuilder builder(Predicate<String> projectTrust) {
        ClaudeRequestParamsBuilder builder = new ClaudeRequestParamsBuilder(new Gson());
        builder.setProjectTrust(projectTrust);
        return builder;
    }

    private static Predicate<String> insideProject(String projectBase) {
        return cwd -> PathUtils.isWorkingDirectoryInsideProject(cwd, projectBase);
    }

    @Test
    public void sendRequestsCarryTheProjectTrust() {
        ClaudeRequestParamsBuilder builder = new ClaudeRequestParamsBuilder(new Gson());
        assertTrue(sendParams(builder, true).get("projectTrusted").getAsBoolean());
        assertFalse(sendParams(builder, false).get("projectTrusted").getAsBoolean());
    }

    @Test
    public void aBuilderWithoutATrustSourceIsUntrusted() {
        assertFalse(new ClaudeRequestParamsBuilder(new Gson()).resolveRequestCwd("/work", NO_CONVERSION).projectTrusted());
    }

    @Test
    public void aFailingTrustSourceIsUntrusted() {
        ClaudeRequestParamsBuilder builder = builder(cwd -> {
            throw new IllegalStateException("no project");
        });
        assertFalse(builder.resolveRequestCwd("/work", NO_CONVERSION).projectTrusted());
    }

    @Test
    public void theTrustSourceDecidesPerWorkingDirectory() {
        ClaudeRequestParamsBuilder builder = builder("/work"::equals);

        assertTrue(builder.resolveRequestCwd("/work", NO_CONVERSION).projectTrusted());
        assertFalse(builder.resolveRequestCwd("/elsewhere", NO_CONVERSION).projectTrusted());
    }

    @Test
    public void trustIsDecidedOnTheIdePathAndTheRequestCarriesTheWslPath() throws IOException {
        File project = tmp.newFolder("project");
        File nested = new File(project, "src");
        assertTrue(nested.mkdirs());
        File outside = tmp.newFolder("other");
        ClaudeRequestParamsBuilder builder = builder(insideProject(project.getPath()));

        ClaudeRequestParamsBuilder.RequestCwd root = builder.resolveRequestCwd(project.getPath(), WslPathUtil::convertToWslPath);
        assertTrue(root.projectTrusted());
        assertEquals(WslPathUtil.convertToWslPath(project.getPath()), root.nodeCwd());

        ClaudeRequestParamsBuilder.RequestCwd sub = builder.resolveRequestCwd(nested.getPath(), WslPathUtil::convertToWslPath);
        assertTrue(sub.projectTrusted());
        assertEquals(WslPathUtil.convertToWslPath(nested.getPath()), sub.nodeCwd());

        assertFalse(builder.resolveRequestCwd(outside.getPath(), WslPathUtil::convertToWslPath).projectTrusted());
    }

    @Test
    public void aDriveLetterProjectIsTrustedThoughNodeRunsInMnt() throws IOException {
        Assume.assumeTrue("drive-letter paths exist only on Windows", File.separatorChar == '\\');
        File project = tmp.newFolder("project");
        ClaudeRequestParamsBuilder builder = builder(insideProject(project.getPath()));

        ClaudeRequestParamsBuilder.RequestCwd requestCwd = builder.resolveRequestCwd(project.getPath(), WslPathUtil::convertToWslPath);

        assertTrue(requestCwd.nodeCwd().startsWith("/mnt/"));
        assertTrue(requestCwd.projectTrusted());
    }

    @Test
    public void aWslUncProjectIsTrustedThoughNodeRunsInItsLinuxPath() {
        String project = "//wsl.localhost/Ubuntu/home/alice/proj";
        ClaudeRequestParamsBuilder builder = builder(insideProject(project));

        ClaudeRequestParamsBuilder.RequestCwd root = builder.resolveRequestCwd(project, WslPathUtil::convertToWslPath);
        assertEquals("/home/alice/proj", root.nodeCwd());
        assertTrue(root.projectTrusted());

        ClaudeRequestParamsBuilder.RequestCwd sub = builder.resolveRequestCwd(
                "\\\\wsl.localhost\\Ubuntu\\home\\alice\\proj\\src", WslPathUtil::convertToWslPath);
        assertEquals("/home/alice/proj/src", sub.nodeCwd());
        assertTrue(sub.projectTrusted());

        ClaudeRequestParamsBuilder.RequestCwd other = builder.resolveRequestCwd(
                "//wsl.localhost/Ubuntu/home/alice/other", WslPathUtil::convertToWslPath);
        assertEquals("/home/alice/other", other.nodeCwd());
        assertFalse(other.projectTrusted());
    }

    @Test
    public void contextUsageRequestsCarryTheNodeCwdAndItsTrust() {
        JsonObject trusted = ClaudeSDKBridge.buildContextUsageParams("s1",
                new ClaudeRequestParamsBuilder.RequestCwd("/mnt/c/work/project", true), "m");
        assertEquals("/mnt/c/work/project", trusted.get("cwd").getAsString());
        assertTrue(trusted.get("projectTrusted").getAsBoolean());

        JsonObject untrusted = ClaudeSDKBridge.buildContextUsageParams("s1",
                new ClaudeRequestParamsBuilder.RequestCwd("/mnt/c/work/other", false), "m");
        assertFalse(untrusted.get("projectTrusted").getAsBoolean());
    }

    @Test
    public void preconnectRequestsCarryTheProjectTrust() {
        assertTrue(ClaudeDaemonCoordinator.buildPreconnectParams("/work", "", "", true).get("projectTrusted").getAsBoolean());
        assertFalse(ClaudeDaemonCoordinator.buildPreconnectParams("/work", "", "", false).get("projectTrusted").getAsBoolean());
    }
}
