package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.extensions.PluginId;

/**
 * 版本信息处理器
 * 处理获取插件版本的请求
 */
public class VersionHandler extends BaseMessageHandler {

    private static final String PLUGIN_ID = "com.github.idea-claude-code-gui";
    private static final String[] SUPPORTED_TYPES = {
        "get_plugin_version"
    };

    public VersionHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("get_plugin_version".equals(type)) {
            handleGetPluginVersion();
            return true;
        }
        return false;
    }

    /**
     * 处理获取插件版本请求
     */
    private void handleGetPluginVersion() {
        try {
            String version = getPluginVersion();
            sendVersionToFrontend(version);
        } catch (Exception e) {
            System.err.println("[VersionHandler] Failed to get plugin version: " + e.getMessage());
            sendVersionToFrontend("0.1.0-unknown");
        }
    }

    /**
     * 获取插件版本
     */
    private String getPluginVersion() {
        PluginId pluginId = PluginId.getId(PLUGIN_ID);

        // 尝试从 PluginManagerCore 获取
        var descriptor = PluginManagerCore.getPlugin(pluginId);
        if (descriptor != null && descriptor.getVersion() != null) {
            System.out.println("[VersionHandler] ✓ Plugin version found: " + descriptor.getVersion());
            return descriptor.getVersion();
        }

        // 如果找不到，返回默认值
        System.out.println("[VersionHandler] ⚠ Could not find plugin version, using default");
        return "0.1.0";
    }

    /**
     * 发送版本信息到前端
     */
    private void sendVersionToFrontend(String version) {
        Gson gson = new Gson();
        JsonObject result = new JsonObject();
        result.addProperty("version", version);

        String jsonStr = gson.toJson(result);
        callJavaScript("window.onPluginVersionReceived", escapeJs(jsonStr));
    }
}

