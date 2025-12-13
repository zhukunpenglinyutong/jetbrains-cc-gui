package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import javax.swing.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;

/**
 * 模型相关消息处理器
 * 处理远程模型列表获取
 */
public class ModelHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
        "fetch_remote_models"
    };

    public ModelHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        System.out.println("[ModelHandler] handle() called with type: " + type);
        switch (type) {
            case "fetch_remote_models":
                handleFetchRemoteModels(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 处理获取远程模型列表请求
     * 根据当前激活的供应商配置，调用 /v1/models API 获取模型列表
     */
    private void handleFetchRemoteModels(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                System.out.println("[ModelHandler] Starting fetch remote models request");

                // 获取当前激活的供应商配置
                JsonObject activeProvider = context.getSettingsService().getActiveClaudeProvider();

                if (activeProvider == null) {
                    System.out.println("[ModelHandler] ⚠ No active provider, using default models");
                    sendModelsToFrontendOnEDT(null, "No active provider configured");
                    return;
                }

                System.out.println("[ModelHandler] ✓ Active provider found: " + activeProvider.toString());

                // 从供应商配置中提取 API 配置
                String baseUrl = null;
                String apiKey = null;

                if (activeProvider.has("settingsConfig") && !activeProvider.get("settingsConfig").isJsonNull()) {
                    JsonObject settingsConfig = activeProvider.getAsJsonObject("settingsConfig");
                    if (settingsConfig.has("env") && !settingsConfig.get("env").isJsonNull()) {
                        JsonObject env = settingsConfig.getAsJsonObject("env");
                        System.out.println("[ModelHandler] ✓ Found env config");

                        // 获取 Base URL
                        if (env.has("ANTHROPIC_BASE_URL") && !env.get("ANTHROPIC_BASE_URL").isJsonNull()) {
                            baseUrl = env.get("ANTHROPIC_BASE_URL").getAsString();
                            System.out.println("[ModelHandler] ✓ Found ANTHROPIC_BASE_URL: " + baseUrl);
                        }

                        // 获取 API Key
                        if (env.has("ANTHROPIC_AUTH_TOKEN") && !env.get("ANTHROPIC_AUTH_TOKEN").isJsonNull()) {
                            apiKey = env.get("ANTHROPIC_AUTH_TOKEN").getAsString();
                            System.out.println("[ModelHandler] ✓ Found ANTHROPIC_AUTH_TOKEN");
                        } else if (env.has("ANTHROPIC_API_KEY") && !env.get("ANTHROPIC_API_KEY").isJsonNull()) {
                            apiKey = env.get("ANTHROPIC_API_KEY").getAsString();
                            System.out.println("[ModelHandler] ✓ Found ANTHROPIC_API_KEY");
                        } else {
                            System.out.println("[ModelHandler] ⚠ Neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY found in env");
                        }
                    } else {
                        System.out.println("[ModelHandler] ⚠ No env config in settingsConfig");
                    }
                } else {
                    System.out.println("[ModelHandler] ⚠ No settingsConfig in active provider");
                }

                // 如果没有配置 Base URL，使用默认的 Anthropic API
                if (baseUrl == null || baseUrl.trim().isEmpty()) {
                    baseUrl = "https://api.anthropic.com";
                    System.out.println("[ModelHandler] Using default base URL: " + baseUrl);
                }

                // 如果没有 API Key，无法获取模型列表
                if (apiKey == null || apiKey.trim().isEmpty()) {
                    System.out.println("[ModelHandler] ⚠ No API key configured, using default models");
                    sendModelsToFrontendOnEDT(null, "No API key configured");
                    return;
                }

                // 调用 /v1/models API
                JsonArray models = fetchModelsFromApi(baseUrl, apiKey);

                if (!models.isEmpty()) {
                    System.out.println("[ModelHandler] ✓ Successfully fetched " + models.size() + " models");
                    sendModelsToFrontendOnEDT(models, null);
                } else {
                    System.out.println("[ModelHandler] ⚠ No models returned from API");
                    sendModelsToFrontendOnEDT(null, "No models returned from API");
                }

            } catch (Exception e) {
                System.err.println("[ModelHandler] ✗ Failed to fetch remote models: " + e.getMessage());
                System.err.println("[ModelHandler] Exception type: " + e.getClass().getName());
                System.err.println("[ModelHandler] Stack trace:");
                for (StackTraceElement element : e.getStackTrace()) {
                    System.err.println("  at " + element);
                }
                sendModelsToFrontendOnEDT(null, e.getMessage());
            }
        });
    }

    /**
     * 调用 /v1/models API 获取模型列表
     */
    private JsonArray fetchModelsFromApi(String baseUrl, String apiKey) throws Exception {
        HttpURLConnection conn = null;
        try {
            // 构建 URL
            String urlStr = baseUrl.endsWith("/") ? baseUrl + "v1/models" : baseUrl + "/v1/models";
            URL url = new URL(urlStr);

            System.out.println("[ModelHandler] Fetching models from: " + urlStr);

            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            // 同时设置多种认证方式，以兼容不同的 API 服务
            // 1. Anthropic 官方 API 使用 x-api-key
            conn.setRequestProperty("x-api-key", apiKey);
            // 2. 很多代理服务使用 Authorization: Bearer
            conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            conn.setRequestProperty("anthropic-version", "2023-06-01");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);

            int responseCode = conn.getResponseCode();
            System.out.println("[ModelHandler] API response code: " + responseCode);

            if (responseCode != 200) {
                // 读取错误响应
                String errorResponse = "";
                try (BufferedReader errorReader = new BufferedReader(
                        new InputStreamReader(conn.getErrorStream(), StandardCharsets.UTF_8))) {
                    if (errorReader != null) {
                        StringBuilder sb = new StringBuilder();
                        String line;
                        while ((line = errorReader.readLine()) != null) {
                            sb.append(line);
                        }
                        errorResponse = sb.toString();
                    }
                }

                System.err.println("[ModelHandler] Error response: " + errorResponse);
                throw new Exception("API returned error " + responseCode + ": " + errorResponse);
            }

            // 读取响应
            String responseBody;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder response = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    response.append(line);
                }
                responseBody = response.toString();
            }

            if (responseBody.isEmpty()) {
                System.out.println("[ModelHandler] Empty response from API");
                return new JsonArray();
            }

            System.out.println("[ModelHandler] Response body: " + responseBody.substring(0, Math.min(200, responseBody.length())) + "...");

            // 解析响应
            Gson gson = new Gson();
            JsonObject responseJson = gson.fromJson(responseBody, JsonObject.class);

            if (responseJson != null && responseJson.has("data") && responseJson.get("data").isJsonArray()) {
                JsonArray data = responseJson.getAsJsonArray("data");
                System.out.println("[ModelHandler] ✓ Fetched " + data.size() + " models from API");
                return data;
            } else {
                System.out.println("[ModelHandler] ⚠ Response JSON doesn't contain 'data' array");
                System.out.println("[ModelHandler] Response JSON: " + (responseJson != null ? responseJson.toString() : "null"));
            }

            return new JsonArray();
        } catch (Exception e) {
            System.err.println("[ModelHandler] ✗ Exception in fetchModelsFromApi: " + e.getClass().getSimpleName() + " - " + e.getMessage());
            throw e;
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception e) {
                    System.err.println("[ModelHandler] Error disconnecting: " + e.getMessage());
                }
            }
        }
    }

    /**
     * 发送模型列表到前端（在 EDT 线程上执行）
     */
    private void sendModelsToFrontendOnEDT(JsonArray models, String error) {
        SwingUtilities.invokeLater(() -> {
            sendModelsToFrontend(models, error);
        });
    }

    /**
     * 发送模型列表到前端
     */
    private void sendModelsToFrontend(JsonArray models, String error) {
        Gson gson = new Gson();
        JsonObject result = new JsonObject();

        if (models != null) {
            result.addProperty("success", true);
            result.add("models", models);
        } else {
            result.addProperty("success", false);
            result.addProperty("error", error != null ? error : "Unknown error");
            // 返回空数组，前端会使用默认模型
            result.add("models", new JsonArray());
        }

        String jsonStr = gson.toJson(result);
        callJavaScript("window.onRemoteModelsLoaded", escapeJs(jsonStr));
    }
}
