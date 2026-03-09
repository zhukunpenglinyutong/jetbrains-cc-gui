package com.github.claudecodegui.util;

import java.util.regex.Pattern;

/**
 * JavaScript utility class.
 * Provides helper methods for JavaScript string escaping and function invocation.
 */
public class JsUtils {

    private static final Pattern SAFE_JS_NAME = Pattern.compile("^[a-zA-Z_$][a-zA-Z0-9_$.]*$");

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
            .replace("\t", "\\t")          // Tab
            .replace("\b", "\\b")          // Backspace
            .replace("\f", "\\f")          // Form feed
            .replace("\u0085", "\\u0085")  // Next Line (NEL)
            .replace("\u2028", "\\u2028")  // Line separator
            .replace("\u2029", "\\u2029")  // Paragraph separator
            .replace("\0", "\\0")          // Null character
            .replace("</", "<\\/");        // Prevent </script> breakout in HTML context
    }

    /**
     * Build a JavaScript function call with an existence check.
     * @param functionName the function name
     * @param args pre-escaped string arguments
     * @return the JavaScript code
     */
    public static String buildJsCall(String functionName, String... args) {
        if (functionName == null || !SAFE_JS_NAME.matcher(functionName).matches()) {
            throw new IllegalArgumentException("Invalid JavaScript function name: " + functionName);
        }
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
        if (objectPath == null || !SAFE_JS_NAME.matcher(objectPath).matches()) {
            throw new IllegalArgumentException("Invalid JavaScript object path: " + objectPath);
        }
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
