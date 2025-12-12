package com.github.claudecodegui.util;

/**
 * JavaScript 工具类
 * 提供 JavaScript 字符串转义和调用相关的工具方法
 */
public class JsUtils {

    /**
     * 转义 JavaScript 字符串
     * 用于将 Java 字符串安全地嵌入到 JavaScript 代码中
     */
    public static String escapeJs(String str) {
        if (str == null) {
            return "";
        }
        return str
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r");
    }

    /**
     * 构建 JavaScript 函数调用代码
     * @param functionName 函数名称
     * @param args 参数列表（已转义的字符串）
     * @return JavaScript 代码
     */
    public static String buildJsCall(String functionName, String... args) {
        StringBuilder js = new StringBuilder();
        // 使用 try-catch 包裹，而不是 typeof 检查
        // 这样即使函数未定义也不会导致错误，只会静默失败
        js.append("(function() { ");
        js.append("try { ");

        // 检查函数是否存在和可调用
        js.append("if (").append(functionName).append(" && typeof ").append(functionName).append(" === 'function') { ");
        js.append(functionName).append("(");

        for (int i = 0; i < args.length; i++) {
            if (i > 0) js.append(", ");
            js.append("'").append(args[i]).append("'");
        }

        js.append("); ");
        js.append("} ");
        js.append("} catch (e) { ");
        js.append("console.error('[JS Call Error] Failed to call ").append(functionName).append(":', e); ");
        js.append("} ");
        js.append("})();");
        return js.toString();
    }

    /**
     * 构建带有存在性检查的 JavaScript 调用
     * @param objectPath 对象路径（如 "window.myFunction"）
     * @param args 参数列表（已转义的字符串）
     * @return JavaScript 代码
     */
    public static String buildSafeJsCall(String objectPath, String... args) {
        StringBuilder js = new StringBuilder();
        // 使用 try-catch 包裹，提高可靠性
        js.append("(function() { ");
        js.append("try { ");
        js.append("if (").append(objectPath).append(" && typeof ").append(objectPath).append(" === 'function') { ");
        js.append(objectPath).append("(");

        for (int i = 0; i < args.length; i++) {
            if (i > 0) js.append(", ");
            js.append("'").append(args[i]).append("'");
        }

        js.append("); ");
        js.append("} ");
        js.append("} catch (e) { ");
        js.append("console.error('[JS Call Error] Failed to call ").append(objectPath).append(":', e); ");
        js.append("} ");
        js.append("})();");
        return js.toString();
    }
}
