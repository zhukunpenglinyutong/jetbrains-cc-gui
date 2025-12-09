package com.github.claudecodegui.handler;

/**
 * 消息处理器接口
 * 用于处理来自前端 JavaScript 的消息
 */
public interface MessageHandler {

    /**
     * 处理消息
     * @param type 消息类型
     * @param content 消息内容
     * @return true 如果消息被处理，false 如果未被处理
     */
    boolean handle(String type, String content);

    /**
     * 获取此 Handler 支持的消息类型前缀
     * 用于快速判断是否应该由此 Handler 处理
     * @return 消息类型前缀数组
     */
    String[] getSupportedTypes();
}
