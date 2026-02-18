package com.github.claudecodegui.util;

/**
 * JavaScript utility class.
 * Provides helper methods for JavaScript string escaping and function invocation.
 */
public class JsUtils {

    /**
     * Escape a string for safe embedding in JavaScript code.
     * Handles special characters including line separators, paragraph separators, etc.
     */
    public static String escapeJs(String str) {
        if (str == null) {
            return "";
        }
        return str
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\"", "\\\"")
            .replace("`", "\\`")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\u2028", "\\u2028")  // Line separator
            .replace("\u2029", "\\u2029")  // Paragraph separator
            .replace("\0", "\\0");         // Null character
    }

    /**
     * Build a JavaScript function call with an existence check.
     * @param functionName the function name
     * @param args pre-escaped string arguments
     * @return the JavaScript code
     */
    public static String buildJsCall(String functionName, String... args) {
        StringBuilder js = new StringBuilder();
        js.append("if (typeof ").append(functionName).append(" === 'function') { ");
        js.append(functionName).append("(");

        for (int i = 0; i < args.length; i++) {
            if (i > 0) js.append(", ");
            js.append("'").append(args[i]).append("'");
        }

        js.append("); }");
        return js.toString();
    }

    /**
     * Build a safe JavaScript call with a truthiness check on the object path.
     * @param objectPath the object path (e.g. "window.myFunction")
     * @param args pre-escaped string arguments
     * @return the JavaScript code
     */
    public static String buildSafeJsCall(String objectPath, String... args) {
        StringBuilder js = new StringBuilder();
        js.append("if (").append(objectPath).append(") { ");
        js.append(objectPath).append("(");

        for (int i = 0; i < args.length; i++) {
            if (i > 0) js.append(", ");
            js.append("'").append(args[i]).append("'");
        }

        js.append("); }");
        return js.toString();
    }
}
