package com.github.claudecodegui.config;

import java.util.concurrent.TimeUnit;

/**
 * 统一的超时配置
 * 用于所有异步操作的超时控制
 */
public class TimeoutConfig {
    /**
     * 快速操作超时：30秒
     * 适用于：启动 Channel、获取命令列表等
     */
    public static final long QUICK_OPERATION_TIMEOUT = 30;
    public static final TimeUnit QUICK_OPERATION_UNIT = TimeUnit.SECONDS;

    /**
     * 消息发送超时：3分钟
     * 适用于：发送消息、AI 响应等
     */
    public static final long MESSAGE_TIMEOUT = 180;
    public static final TimeUnit MESSAGE_UNIT = TimeUnit.SECONDS;

    /**
     * 长时间操作超时：10分钟
     * 适用于：文件索引、大量数据处理等
     */
    public static final long LONG_OPERATION_TIMEOUT = 600;
    public static final TimeUnit LONG_OPERATION_UNIT = TimeUnit.SECONDS;

    private TimeoutConfig() {
        // 工具类，不允许实例化
    }
}
