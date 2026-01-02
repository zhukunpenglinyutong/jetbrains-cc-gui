package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * 工作目录管理器
 * 负责管理项目自定义工作目录配置
 */
public class WorkingDirectoryManager {
    private static final Logger LOG = Logger.getInstance(WorkingDirectoryManager.class);

    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;

    public WorkingDirectoryManager(
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter) {
        this.configReader = configReader;
        this.configWriter = configWriter;
    }

    /**
     * 获取自定义工作目录配置
     * @param projectPath 项目根路径
     * @return 自定义工作目录,如果未配置则返回 null
     */
    public String getCustomWorkingDirectory(String projectPath) {
        JsonObject config = configReader.apply(null);

        if (!config.has("workingDirectories") || config.get("workingDirectories").isJsonNull()) {
            return null;
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");

        if (workingDirs.has(projectPath) && !workingDirs.get(projectPath).isJsonNull()) {
            return workingDirs.get(projectPath).getAsString();
        }

        return null;
    }

    /**
     * 设置自定义工作目录
     * @param projectPath 项目根路径
     * @param customWorkingDir 自定义工作目录(相对于项目根路径或绝对路径)
     */
    public void setCustomWorkingDirectory(String projectPath, String customWorkingDir) throws IOException {
        JsonObject config = configReader.apply(null);

        // 确保 workingDirectories 节点存在
        if (!config.has("workingDirectories")) {
            config.add("workingDirectories", new JsonObject());
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");

        if (customWorkingDir == null || customWorkingDir.trim().isEmpty()) {
            // 如果传入空值,移除配置
            workingDirs.remove(projectPath);
        } else {
            // 设置自定义工作目录
            workingDirs.addProperty(projectPath, customWorkingDir.trim());
        }

        configWriter.accept(config);
        LOG.info("[WorkingDirectoryManager] Set custom working directory for " + projectPath + ": " + customWorkingDir);
    }

    /**
     * 获取所有工作目录配置
     * @return Map<projectPath, customWorkingDir>
     */
    public Map<String, String> getAllWorkingDirectories() {
        Map<String, String> result = new HashMap<>();
        JsonObject config = configReader.apply(null);

        if (!config.has("workingDirectories") || config.get("workingDirectories").isJsonNull()) {
            return result;
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");
        for (String key : workingDirs.keySet()) {
            result.put(key, workingDirs.get(key).getAsString());
        }

        return result;
    }
}
