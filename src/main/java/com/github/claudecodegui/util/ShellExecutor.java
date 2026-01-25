package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/**
 * Shell 命令执行工具类
 * 封装进程执行、超时处理和输出过滤的通用逻辑
 */
public final class ShellExecutor {

    private static final Logger LOG = Logger.getInstance(ShellExecutor.class);

    /**
     * 默认进程超时时间（秒）
     */
    public static final int DEFAULT_TIMEOUT_SECONDS = 5;

    private ShellExecutor() {
        // 工具类不允许实例化
    }

    /**
     * 执行结果
     */
    public static class ExecutionResult {
        private final boolean success;
        private final String output;
        private final List<String> allLines;
        private final List<String> filteredLines;

        private ExecutionResult(boolean success, String output, List<String> allLines, List<String> filteredLines) {
            this.success = success;
            this.output = output;
            this.allLines = allLines;
            this.filteredLines = filteredLines;
        }

        public boolean isSuccess() {
            return success;
        }

        public String getOutput() {
            return output;
        }

        public List<String> getAllLines() {
            return allLines;
        }

        public List<String> getFilteredLines() {
            return filteredLines;
        }

        public static ExecutionResult success(String output, List<String> allLines, List<String> filteredLines) {
            return new ExecutionResult(true, output, allLines, filteredLines);
        }

        public static ExecutionResult failure() {
            return new ExecutionResult(false, null, List.of(), List.of());
        }

        public static ExecutionResult timeout() {
            return new ExecutionResult(false, null, List.of(), List.of());
        }
    }

    /**
     * 执行 Shell 命令并返回第一行有效输出
     *
     * @param command      命令列表
     * @param lineFilter   行过滤器，返回 true 表示该行有效
     * @param logPrefix    日志前缀
     * @return 执行结果
     */
    public static ExecutionResult execute(List<String> command, Predicate<String> lineFilter, String logPrefix) {
        return execute(command, lineFilter, logPrefix, DEFAULT_TIMEOUT_SECONDS, true);
    }

    /**
     * 执行 Shell 命令并返回结果
     *
     * @param command          命令列表
     * @param lineFilter       行过滤器，返回 true 表示该行有效
     * @param logPrefix        日志前缀
     * @param timeoutSeconds   超时时间（秒）
     * @param useInteractive   是否使用交互式 shell 配置（设置 TERM=dumb）
     * @return 执行结果
     */
    public static ExecutionResult execute(
            List<String> command,
            Predicate<String> lineFilter,
            String logPrefix,
            int timeoutSeconds,
            boolean useInteractive
    ) {
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            if (useInteractive) {
                // 设置 TERM=dumb 抑制交互式 shell 的额外输出（如颜色代码、提示符等）
                pb.environment().put("TERM", "dumb");
            }
            pb.redirectErrorStream(true);

            Process process = pb.start();

            // 先等待进程完成（带超时），确保不会因 readLine 阻塞
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                LOG.debug(logPrefix + " 命令超时");
                process.destroyForcibly();
                return ExecutionResult.timeout();
            }

            // 进程已完成，现在可以安全地读取输出
            List<String> allLines = new ArrayList<>();
            List<String> filteredLines = new ArrayList<>();
            String validOutput = null;

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    allLines.add(trimmed);

                    if (lineFilter.test(trimmed)) {
                        validOutput = trimmed;
                        // 找到第一个有效行就返回
                        break;
                    } else if (!trimmed.isEmpty()) {
                        // 记录被过滤的非空行，便于调试
                        filteredLines.add(trimmed);
                    }
                }

                // 读取剩余行
                while ((line = reader.readLine()) != null) {
                    allLines.add(line.trim());
                }
            }

            // DEBUG 级别记录被过滤的行
            if (!filteredLines.isEmpty() && LOG.isDebugEnabled()) {
                LOG.debug(logPrefix + " 过滤掉的行: " + filteredLines);
            }

            if (validOutput != null) {
                return ExecutionResult.success(validOutput, allLines, filteredLines);
            }

            return ExecutionResult.failure();
        } catch (Exception e) {
            LOG.debug(logPrefix + " 执行失败: " + e.getMessage());
            return ExecutionResult.failure();
        }
    }

    /**
     * 执行 Shell 命令并返回最后一个有效输出（用于环境变量获取）
     *
     * @param command          命令列表
     * @param lineFilter       行过滤器，返回 true 表示该行有效
     * @param logPrefix        日志前缀
     * @param timeoutSeconds   超时时间（秒）
     * @return 执行结果
     */
    public static ExecutionResult executeAndGetLast(
            List<String> command,
            Predicate<String> lineFilter,
            String logPrefix,
            int timeoutSeconds
    ) {
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            // 设置 TERM=dumb 抑制交互式 shell 的额外输出
            pb.environment().put("TERM", "dumb");
            pb.redirectErrorStream(true);

            Process process = pb.start();

            // 先等待进程完成（带超时）
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                LOG.debug(logPrefix + " 命令超时");
                process.destroyForcibly();
                return ExecutionResult.timeout();
            }

            // 读取所有输出，保留最后一个有效值
            List<String> allLines = new ArrayList<>();
            List<String> filteredLines = new ArrayList<>();
            String lastValidValue = null;

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    allLines.add(trimmed);

                    if (lineFilter.test(trimmed)) {
                        lastValidValue = trimmed;
                    } else if (!trimmed.isEmpty()) {
                        filteredLines.add(trimmed);
                    }
                }
            }

            // DEBUG 级别记录被过滤的行
            if (!filteredLines.isEmpty() && LOG.isDebugEnabled()) {
                LOG.debug(logPrefix + " 过滤掉的行: " + filteredLines);
            }

            if (lastValidValue != null) {
                return ExecutionResult.success(lastValidValue, allLines, filteredLines);
            }

            return ExecutionResult.failure();
        } catch (Exception e) {
            LOG.debug(logPrefix + " 执行失败: " + e.getMessage());
            return ExecutionResult.failure();
        }
    }

    /**
     * 创建交互式 Shell 输出的默认过滤器
     * 过滤常见的 shell 提示符、登录消息等
     *
     * @return 行过滤器
     */
    public static Predicate<String> createShellOutputFilter() {
        return line -> {
            if (line == null || line.isEmpty()) {
                return false;
            }
            // 跳过常见的 shell 输出干扰
            return !line.startsWith("[") &&         // Skip MOTD brackets
                   !line.startsWith("%") &&         // Skip zsh prompts
                   !line.startsWith(">") &&         // Skip continuation prompts
                   !line.contains("Last login");    // Skip login messages
        };
    }

    /**
     * 创建 Node.js 路径的过滤器
     *
     * @return 行过滤器
     */
    public static Predicate<String> createNodePathFilter() {
        return line -> {
            if (line == null || line.isEmpty()) {
                return false;
            }
            // 有效的 node 路径应该以 / 开头，以 /node 结尾，不包含错误信息
            return line.startsWith("/") &&
                   !line.contains("not found") &&
                   line.endsWith("/node");
        };
    }
}
