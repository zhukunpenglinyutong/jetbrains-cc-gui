package com.github.claudecodegui.handler;

/**
 * 消息处理器基类
 * 提供通用的工具方法
 */
public abstract class BaseMessageHandler implements MessageHandler {

    protected final HandlerContext context;

    public BaseMessageHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * 调用 JavaScript 函数
     */
    protected void callJavaScript(String functionName, String... args) {
        context.callJavaScript(functionName, args);
    }

    /**
     * 转义 JavaScript 字符串
     */
    protected String escapeJs(String str) {
        return context.escapeJs(str);
    }

    /**
     * 在 EDT 线程上执行 JavaScript
     */
    protected void executeJavaScript(String jsCode) {
        context.executeJavaScriptOnEDT(jsCode);
    }

    /**
     * 检查消息类型是否匹配
     */
    protected boolean matchesType(String type, String... supportedTypes) {
        for (String supported : supportedTypes) {
            if (supported.equals(type)) {
                return true;
            }
        }
        return false;
    }
}
