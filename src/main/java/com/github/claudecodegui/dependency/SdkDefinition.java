package com.github.claudecodegui.dependency;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * SDK 定义枚举
 * 定义可安装的 AI SDK 包信息
 */
public enum SdkDefinition {

    CLAUDE_SDK(
        "claude-sdk",
        "Claude Code SDK",
        "@anthropic-ai/claude-agent-sdk",
        "^0.2.3",
        Arrays.asList("@anthropic-ai/sdk", "@anthropic-ai/bedrock-sdk"),
        "Claude AI 提供商所需，包含 Agent SDK 和 Bedrock 支持。"
    ),

    CODEX_SDK(
        "codex-sdk",
        "Codex SDK",
        "@openai/codex-sdk",
        "latest",
        Collections.emptyList(),
        "Codex AI 提供商所需。"
    );

    private final String id;
    private final String displayName;
    private final String npmPackage;
    private final String version;
    private final List<String> dependencies;
    private final String description;

    SdkDefinition(String id, String displayName, String npmPackage, String version,
                  List<String> dependencies, String description) {
        this.id = id;
        this.displayName = displayName;
        this.npmPackage = npmPackage;
        this.version = version;
        this.dependencies = dependencies;
        this.description = description;
    }

    public String getId() {
        return id;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getNpmPackage() {
        return npmPackage;
    }

    public String getVersion() {
        return version;
    }

    public List<String> getDependencies() {
        return dependencies;
    }

    public String getDescription() {
        return description;
    }

    /**
     * 获取完整的 npm 安装包名（包含版本）
     * 例如: @anthropic-ai/claude-agent-sdk@^0.1.76
     */
    public String getFullPackageSpec() {
        return npmPackage + "@" + version;
    }

    /**
     * 获取所有需要安装的包（主包 + 依赖包）
     */
    public List<String> getAllPackages() {
        if (dependencies.isEmpty()) {
            return Collections.singletonList(getFullPackageSpec());
        }
        java.util.ArrayList<String> all = new java.util.ArrayList<>();
        all.add(getFullPackageSpec());
        all.addAll(dependencies);
        return all;
    }

    /**
     * 根据 ID 查找 SDK 定义
     */
    public static SdkDefinition fromId(String id) {
        for (SdkDefinition sdk : values()) {
            if (sdk.getId().equals(id)) {
                return sdk;
            }
        }
        return null;
    }

    /**
     * 根据提供商名称查找对应的 SDK
     */
    public static SdkDefinition fromProvider(String provider) {
        if ("claude".equalsIgnoreCase(provider)) {
            return CLAUDE_SDK;
        } else if ("codex".equalsIgnoreCase(provider)) {
            return CODEX_SDK;
        }
        return null;
    }
}
