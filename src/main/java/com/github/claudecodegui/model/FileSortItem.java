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
        // Add null safety checks with default values
        this.path = json.has("path") ? json.get("path").getAsString() : "";
        this.isDir = json.has("type") && "directory".equals(json.get("type").getAsString());
        this.name = json.has("name") ? json.get("name").getAsString() : "";
    }

    public int getDepth() {
        if (depth == -1) {
            // Optimized: use character counting instead of split() for better performance
            depth = path.isEmpty() ? 0 : countPathSeparators(path) + 1;
        }
        return depth;
    }

    /**
     * Count the number of path separators in a string
     * More efficient than split() for large file lists
     */
    private static int countPathSeparators(String path) {
        int count = 0;
        for (int i = 0; i < path.length(); i++) {
            if (path.charAt(i) == '/') {
                count++;
            }
        }
        return count;
    }

    public String getParentPath() {
        if (parentPath == null) {
            int lastSlash = path.lastIndexOf('/');
            parentPath = lastSlash >= 0 ? path.substring(0, lastSlash) : "";
        }
        return parentPath;
    }
}
