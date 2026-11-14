package com.github.claudecodegui.dependency;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;

public class DependencyManagerNpmCommandTest {

    private static final String WSL_NODE = "/home/debian/.local/node/bin/node";
    private static final String WSL_NPM = "/home/debian/.local/node/bin/npm";
    private static final String WSL_NPM_CLI = "/home/debian/.local/node/lib/node_modules/npm/bin/npm-cli.js";
    private static final String WSL_PREFIX = "/home/debian/.codemoss/dependencies/claude-sdk";

    @Test
    public void wslInstallRunsNpmCliWithTheConfiguredNodeWhenNpmIsNotOnWslPath() {
        List<String> invocation = DependencyManager.npmInvocation(true, WSL_NODE, WSL_NPM, false);

        List<String> command = DependencyManager.buildInstallCommand(
                invocation, WSL_PREFIX, List.of("@anthropic-ai/claude-agent-sdk@0.3.220", "@anthropic-ai/sdk"), 1);

        assertEquals(List.of("wsl", WSL_NODE, WSL_NPM_CLI,
                "install", "--include=optional", "--ignore-scripts", "--prefix", WSL_PREFIX, "--force",
                "@anthropic-ai/claude-agent-sdk@0.3.220", "@anthropic-ai/sdk"), command);
    }

    @Test
    public void wslVersionQueryRunsNpmCliWithTheConfiguredNodeWhenNpmIsNotOnWslPath() {
        List<String> invocation = DependencyManager.npmInvocation(true, WSL_NODE, WSL_NPM, false);

        List<String> command = DependencyManager.buildNpmCommand(
                invocation, "view", "@anthropic-ai/claude-agent-sdk", "versions", "dist-tags.latest", "--json");

        assertEquals(List.of("wsl", WSL_NODE, WSL_NPM_CLI,
                "view", "@anthropic-ai/claude-agent-sdk", "versions", "dist-tags.latest", "--json"), command);
    }

    @Test
    public void wslNpmFoundOnWslPathRunsDirectly() {
        List<String> invocation = DependencyManager.npmInvocation(true, "/usr/bin/node", "/usr/bin/npm", true);

        List<String> command = DependencyManager.buildNpmCommand(
                invocation, "view", "@anthropic-ai/claude-agent-sdk", "version");

        assertEquals(List.of("wsl", "/usr/bin/npm", "view", "@anthropic-ai/claude-agent-sdk", "version"), command);
    }

    @Test
    public void nativeInstallRunsTheResolvedNpm() {
        List<String> invocation = DependencyManager.npmInvocation(false, "/usr/local/bin/node", "/usr/local/bin/npm", false);

        List<String> command = DependencyManager.buildInstallCommand(
                invocation, "/Users/dev/.codemoss/dependencies/claude-sdk", List.of("@anthropic-ai/sdk"), 0);

        assertEquals(List.of("/usr/local/bin/npm",
                "install", "--include=optional", "--ignore-scripts",
                "--prefix", "/Users/dev/.codemoss/dependencies/claude-sdk", "@anthropic-ai/sdk"), command);
    }

    @Test
    public void nativeVersionQueryRunsTheResolvedNpm() {
        List<String> invocation = DependencyManager.npmInvocation(false, "C:\\nodejs\\node.exe", "C:\\nodejs\\npm.cmd", false);

        List<String> command = DependencyManager.buildNpmCommand(
                invocation, "view", "@anthropic-ai/claude-agent-sdk", "version");

        assertEquals(List.of("C:\\nodejs\\npm.cmd", "view", "@anthropic-ai/claude-agent-sdk", "version"), command);
    }
}
