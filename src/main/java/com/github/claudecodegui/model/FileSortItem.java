package com.github.claudecodegui.model;

import com.google.gson.JsonObject;

/**
 * 排序辅助类
 */
public class FileSortItem {

    public final JsonObject json;
    public final int priority;
    public final String path;
    public final boolean isDir;
    public final String name;

    // 懒加载字段
    private int depth = -1;
    private String parentPath = null;

    public FileSortItem(JsonObject json) {
        this.json = json;
        this.priority = json.has("priority")
            ? json.get("priority").getAsInt()
            : 3;
        // 只有 priority >= 3 时才需要以下字段参与复杂排序，但为了简化逻辑，这里先读取基本字段
        this.path = json.get("path").getAsString();
        this.isDir = "directory".equals(json.get("type").getAsString());
        this.name = json.get("name").getAsString();
    }

    public int getDepth() {
        if (depth == -1) {
            depth = path.isEmpty() ? 0 : path.split("/").length;
        }
        return depth;
    }

    public String getParentPath() {
        if (parentPath == null) {
            int lastSlash = path.lastIndexOf('/');
            parentPath = lastSlash >= 0 ? path.substring(0, lastSlash) : "";
        }
        return parentPath;
    }
}
