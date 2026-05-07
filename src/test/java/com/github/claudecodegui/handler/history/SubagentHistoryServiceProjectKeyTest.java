package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PathUtils;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

import static org.junit.Assert.assertEquals;

public class SubagentHistoryServiceProjectKeyTest {

    @Test
    public void unixProjectKeyShouldMatchSanitizedPath() throws Exception {
        String basePath = "/Users/test/project-dir";

        SubagentHistoryService service = new SubagentHistoryService(createContext(basePath));
        assertEquals(PathUtils.sanitizePath(basePath), invokeProjectKey(service));
    }

    @Test
    public void windowsProjectKeyShouldMatchSanitizedPath() throws Exception {
        String basePath = "D:\\Projects\\MyProject";

        SubagentHistoryService service = new SubagentHistoryService(createContext(basePath));
        assertEquals(PathUtils.sanitizePath(basePath), invokeProjectKey(service));
    }

    private static HandlerContext createContext(String basePath) {
        Project project = (Project) Proxy.newProxyInstance(
                SubagentHistoryServiceProjectKeyTest.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "getBasePath" -> basePath;
                    case "getName" -> "test-project";
                    case "isDisposed" -> false;
                    case "toString" -> "test-project";
                    case "hashCode" -> 1;
                    case "equals" -> proxy == args[0];
                    default -> defaultValue(method.getReturnType());
                }
        );

        return new HandlerContext(project, null, null, null, new NoopJsCallback());
    }

    private static String invokeProjectKey(SubagentHistoryService service) throws Exception {
        Method method = SubagentHistoryService.class.getDeclaredMethod("projectKey");
        method.setAccessible(true);
        return (String) method.invoke(service);
    }

    private static Object defaultValue(Class<?> returnType) {
        if (!returnType.isPrimitive()) {
            return null;
        }
        if (boolean.class.equals(returnType)) {
            return false;
        }
        if (int.class.equals(returnType)) {
            return 0;
        }
        if (long.class.equals(returnType)) {
            return 0L;
        }
        if (double.class.equals(returnType)) {
            return 0D;
        }
        if (float.class.equals(returnType)) {
            return 0F;
        }
        if (short.class.equals(returnType)) {
            return (short) 0;
        }
        if (byte.class.equals(returnType)) {
            return (byte) 0;
        }
        if (char.class.equals(returnType)) {
            return (char) 0;
        }
        return null;
    }

    private static final class NoopJsCallback implements HandlerContext.JsCallback {
        @Override
        public void callJavaScript(String functionName, String... args) {
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }
    }
}
