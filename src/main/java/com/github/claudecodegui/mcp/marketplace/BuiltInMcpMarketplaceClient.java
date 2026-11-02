package com.github.claudecodegui.mcp.marketplace;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Provides the curated presets that were previously shown by the static preset dialog.
 */
final class BuiltInMcpMarketplaceClient {

    List<McpMarketplaceEntry> loadEntries(McpMarketplaceSource source) {
        List<McpMarketplaceEntry> entries = new ArrayList<>();
        entries.add(createNpmEntry(
            source,
            "fetch",
            "mcp-server-fetch",
            "Fetch web pages and convert them into model-friendly content.",
            "mcp-server-fetch",
            "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
            Arrays.asList("stdio", "web", "http")
        ));
        entries.add(createNpmEntry(
            source,
            "time",
            "@modelcontextprotocol/server-time",
            "Provide current time and timezone conversion utilities.",
            "@modelcontextprotocol/server-time",
            "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
            Arrays.asList("stdio", "time", "utility")
        ));
        entries.add(createNpmEntry(
            source,
            "memory",
            "@modelcontextprotocol/server-memory",
            "Persist and query a local knowledge graph across chats.",
            "@modelcontextprotocol/server-memory",
            "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
            Arrays.asList("stdio", "memory", "graph")
        ));
        entries.add(createNpmEntry(
            source,
            "sequential-thinking",
            "@modelcontextprotocol/server-sequential-thinking",
            "Expose a structured sequential-thinking tool for planning and reasoning.",
            "@modelcontextprotocol/server-sequential-thinking",
            "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
            Arrays.asList("stdio", "thinking", "reasoning")
        ));
        entries.add(createNpmEntry(
            source,
            "context7",
            "@upstash/context7-mcp",
            "Retrieve current library documentation and code examples.",
            "@upstash/context7-mcp",
            "https://github.com/upstash/context7/blob/master/README.md",
            Arrays.asList("stdio", "docs", "search")
        ));
        entries.add(createRemoteEntry(
            source,
            "keenable",
            "Keenable",
            "Search the web and fetch pages as Markdown, no API key required.",
            "https://api.keenable.ai/mcp-public?keenable_title=cc-gui",
            "https://docs.keenable.ai/mcp-server",
            Arrays.asList("http", "web", "search")
        ));
        return entries;
    }

    private static McpMarketplaceEntry createNpmEntry(
        McpMarketplaceSource source,
        String id,
        String displayName,
        String description,
        String packageName,
        String docsUrl,
        List<String> tags
    ) {
        return createEntry(source, id, displayName, description, docsUrl, tags, new McpInstallOption(
            "NPX package",
            "stdio",
            "npx",
            Arrays.asList("-y", packageName),
            null,
            null,
            null,
            source.getName(),
            "local-command"
        ));
    }

    private static McpMarketplaceEntry createRemoteEntry(
        McpMarketplaceSource source,
        String id,
        String displayName,
        String description,
        String url,
        String docsUrl,
        List<String> tags
    ) {
        return createEntry(source, id, displayName, description, docsUrl, tags, new McpInstallOption(
            "HTTP remote",
            "http",
            null,
            null,
            url,
            null,
            null,
            source.getName(),
            "remote"
        ));
    }

    private static McpMarketplaceEntry createEntry(
        McpMarketplaceSource source,
        String id,
        String displayName,
        String description,
        String docsUrl,
        List<String> tags,
        McpInstallOption installOption
    ) {
        McpMarketplaceEntry.Builder builder = McpMarketplaceEntry.builder()
            .id(source.getId() + ":" + id)
            .name(id)
            .displayName(displayName)
            .description(description)
            .status("active")
            .source(source)
            .homepage(docsUrl)
            .repositoryUrl(docsUrl)
            .docsUrl(docsUrl)
            .official(true)
            .addInstallOption(installOption);
        for (String tag : tags) {
            builder.addTag(tag);
        }
        return builder.build();
    }
}
