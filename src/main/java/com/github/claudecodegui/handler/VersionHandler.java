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
        // 立即测试版本获取
        System.out.println("[VersionHandler] Initializing - testing version retrieval...");
        try {
            String version = getPluginVersion();
            System.out.println("[VersionHandler] Constructor: detected version = " + version);
        } catch (Exception e) {
            System.err.println("[VersionHandler] Constructor: failed to get version: " + e.getMessage());
            e.printStackTrace();
        }
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        System.out.println("[VersionHandler] handle() called with type: " + type);
        if ("get_plugin_version".equals(type)) {
            System.out.println("[VersionHandler] Processing get_plugin_version request");
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
        System.out.println("[VersionHandler] Getting plugin version for ID: " + PLUGIN_ID);
        PluginId pluginId = PluginId.getId(PLUGIN_ID);
        System.out.println("[VersionHandler] PluginId created: " + pluginId);

        // 尝试从 PluginManagerCore 获取
        var descriptor = PluginManagerCore.getPlugin(pluginId);
        System.out.println("[VersionHandler] Plugin descriptor: " + descriptor);

        if (descriptor != null) {
            String version = descriptor.getVersion();
            System.out.println("[VersionHandler] Descriptor version: " + version);
            if (version != null && !version.isEmpty()) {
                System.out.println("[VersionHandler] ✓ Plugin version found: " + version);
                return version;
            }
        }

        // 如果找不到，返回默认值
        System.out.println("[VersionHandler] ⚠ Could not find plugin version, using default");
        return "0.1.0";
    }

    /**
     * 发送版本信息到前端
     */
    private void sendVersionToFrontend(String version) {
        System.out.println("[VersionHandler] Sending version to frontend: " + version);
        Gson gson = new Gson();
        JsonObject result = new JsonObject();
        result.addProperty("version", version);

        String jsonStr = gson.toJson(result);
        System.out.println("[VersionHandler] JSON to send: " + jsonStr);
        callJavaScript("window.onPluginVersionReceived", escapeJs(jsonStr));
        System.out.println("[VersionHandler] Version sent to frontend successfully");
    }
}

