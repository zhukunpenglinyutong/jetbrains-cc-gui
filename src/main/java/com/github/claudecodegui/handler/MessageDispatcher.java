package com.github.claudecodegui.handler;

import java.util.ArrayList;
import java.util.List;

/**
 * 消息分发器
 * 负责将消息分发到合适的 Handler 处理
 */
public class MessageDispatcher {

    private final List<MessageHandler> handlers = new ArrayList<>();

    /**
     * 注册消息处理器
     */
    public void registerHandler(MessageHandler handler) {
        handlers.add(handler);
    }

    /**
     * 分发消息到合适的处理器
     * @param type 消息类型
     * @param content 消息内容
     * @return true 如果消息被处理，false 如果没有处理器能处理此消息
     */
    public boolean dispatch(String type, String content) {
        for (MessageHandler handler : handlers) {
            if (handler.handle(type, content)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 检查是否有处理器支持指定的消息类型
     */
    public boolean hasHandlerFor(String type) {
        for (MessageHandler handler : handlers) {
            for (String supported : handler.getSupportedTypes()) {
                if (supported.equals(type)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 获取所有已注册的处理器数量
     */
    public int getHandlerCount() {
        return handlers.size();
    }

    /**
     * 清除所有处理器
     */
    public void clear() {
        handlers.clear();
    }
}
