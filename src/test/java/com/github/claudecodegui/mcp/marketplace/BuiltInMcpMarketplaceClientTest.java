package com.github.claudecodegui.mcp.marketplace;

import org.junit.Assert;
import org.junit.Test;

import java.util.List;

public class BuiltInMcpMarketplaceClientTest {

    private final McpMarketplaceSource source = McpMarketplaceSource.defaults().get(0);

    private McpMarketplaceEntry entryNamed(String name) {
        for (McpMarketplaceEntry entry : new BuiltInMcpMarketplaceClient().loadEntries(source)) {
            if (name.equals(entry.getName())) {
                return entry;
            }
        }
        Assert.fail("expected built-in preset " + name);
        return null;
    }

    @Test
    public void npxPresetsKeepTheirLocalCommand() {
        for (String name : List.of("fetch", "time", "memory", "sequential-thinking", "context7")) {
            List<McpInstallOption> options = entryNamed(name).getInstallOptions();
            Assert.assertEquals(1, options.size());
            McpInstallOption option = options.get(0);
            Assert.assertEquals("stdio", option.getType());
            Assert.assertEquals("npx", option.getCommand());
            Assert.assertEquals("-y", option.getArgs().get(0));
            Assert.assertNull(option.getUrl());
            Assert.assertEquals("local-command", option.getRiskLevel());
        }
    }

    @Test
    public void keenablePresetIsAKeylessHttpRemote() {
        McpMarketplaceEntry entry = entryNamed("keenable");
        Assert.assertEquals("built-in:keenable", entry.getId());
        Assert.assertEquals("built-in", entry.getSourceId());
        Assert.assertTrue(entry.isInstallable());
        Assert.assertEquals("https://docs.keenable.ai/mcp-server", entry.getDocsUrl());

        List<McpInstallOption> options = entry.getInstallOptions();
        Assert.assertEquals(1, options.size());
        McpInstallOption option = options.get(0);
        Assert.assertEquals("http", option.getType());
        Assert.assertEquals("https://api.keenable.ai/mcp-public?keenable_title=cc-gui", option.getUrl());
        Assert.assertNull(option.getCommand());
        Assert.assertTrue(option.getArgs().isEmpty());
        // No API key placeholder: the public endpoint works without one.
        Assert.assertTrue(option.getHeaders().isEmpty());
        Assert.assertTrue(option.getEnv().isEmpty());
        Assert.assertEquals("remote", option.getRiskLevel());
        Assert.assertEquals("Built-in Presets", option.getSource());
    }
}
