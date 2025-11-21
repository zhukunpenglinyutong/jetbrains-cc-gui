package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Claude Agent SDK Java 测试类
 * 通过 ProcessBuilder 调用 Node.js 脚本来使用 Claude Agent SDK
 */
public class ClaudeSDKTest {

    private static final String SDK_DIR = "claude-bridge";
    private static final String NODE_SCRIPT = "simple-query.js";
    private final Gson gson = new Gson();

    /**
     * SDK 响应结果
     */
    public static class SDKResult {
        public boolean success;
        public String error;
        public int messageCount;
        public List<Object> messages;
        public String rawOutput;

        public SDKResult() {
            this.messages = new ArrayList<>();
        }
    }

    /**
     * 检查 Node.js 环境
     */
    public boolean checkNodeEnvironment() {
        try {
            ProcessBuilder pb = new ProcessBuilder("node", "--version");
            Process process = pb.start();

            BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)
            );

            String version = reader.readLine();
            int exitCode = process.waitFor();

            if (exitCode == 0) {
                System.out.println("✓ Node.js 已安装: " + version);
                return true;
            }
        } catch (Exception e) {
            System.err.println("✗ Node.js 未安装或无法访问: " + e.getMessage());
        }
        return false;
    }

    /**
     * 检查 SDK 是否已安装
     */
    public boolean checkSDKInstalled() {
        File packageJson = new File(SDK_DIR, "package.json");
        File nodeModules = new File(SDK_DIR, "node_modules");

        if (!packageJson.exists()) {
            System.err.println("✗ package.json 不存在");
            return false;
        }

        if (!nodeModules.exists() || !nodeModules.isDirectory()) {
            System.err.println("✗ node_modules 不存在，请先运行: cd claude-bridge && npm install");
            return false;
        }

        System.out.println("✓ SDK 环境检查通过");
        return true;
    }

    /**
     * 执行 Claude SDK 查询
     *
     * @param prompt 提示词
     * @return SDK 结果
     */
    public SDKResult executeQuery(String prompt) {
        SDKResult result = new SDKResult();
        StringBuilder output = new StringBuilder();
        StringBuilder jsonBuffer = new StringBuilder();
        boolean inJson = false;

        try {
            // 构建命令
            List<String> command = new ArrayList<>();
            command.add("node");
            command.add(NODE_SCRIPT);
            command.add(prompt);

            // 创建进程
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(new File(SDK_DIR));
            pb.redirectErrorStream(true); // 合并 stderr 到 stdout

            System.out.println("执行命令: " + String.join(" ", command));
            System.out.println("工作目录: " + pb.directory().getAbsolutePath());
            System.out.println("---");

            Process process = pb.start();

            // 读取输出
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                    System.out.println(line);

                    // 提取 JSON 结果
                    if (line.contains("[JSON_START]")) {
                        inJson = true;
                        jsonBuffer.setLength(0); // 清空缓冲区
                        continue;
                    }
                    if (line.contains("[JSON_END]")) {
                        inJson = false;
                        continue;
                    }
                    if (inJson) {
                        jsonBuffer.append(line).append("\n");
                    }
                }
            }

            // 等待进程结束
            boolean finished = process.waitFor(60, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                result.success = false;
                result.error = "进程超时";
                return result;
            }

            int exitCode = process.exitValue();
            result.rawOutput = output.toString();

            // 解析 JSON 结果
            if (jsonBuffer.length() > 0) {
                try {
                    String jsonStr = jsonBuffer.toString().trim();
                    JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                    result.success = jsonResult.get("success").getAsBoolean();

                    if (result.success) {
                        result.messageCount = jsonResult.get("messageCount").getAsInt();
                        System.out.println("\n✓ SDK 调用成功!");
                        System.out.println("  消息数: " + result.messageCount);
                    } else {
                        result.error = jsonResult.get("error").getAsString();
                        System.err.println("\n✗ SDK 调用失败: " + result.error);
                    }
                } catch (Exception e) {
                    result.success = false;
                    result.error = "JSON 解析失败: " + e.getMessage();
                }
            } else {
                result.success = exitCode == 0;
                if (!result.success) {
                    result.error = "进程退出码: " + exitCode;
                }
            }

        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
            result.rawOutput = output.toString();
            e.printStackTrace();
        }

        return result;
    }

    /**
     * 运行完整测试流程
     */
    public void runFullTest() {
        System.out.println("=== Claude Agent SDK Java 集成测试 ===\n");

        // 1. 检查环境
        System.out.println("步骤 1: 检查 Node.js 环境");
        if (!checkNodeEnvironment()) {
            System.err.println("请先安装 Node.js: https://nodejs.org/");
            return;
        }
        System.out.println();

        // 2. 检查 SDK
        System.out.println("步骤 2: 检查 SDK 安装");
        if (!checkSDKInstalled()) {
            System.err.println("请先安装依赖:");
            System.err.println("  cd claude-bridge");
            System.err.println("  npm install");
            return;
        }
        System.out.println();

        // 3. 执行测试查询
        System.out.println("步骤 3: 执行测试查询");
        System.out.println("提示词: 'What is 2+2? Just give me the answer.'");
        System.out.println();

        SDKResult result = executeQuery("What is 2+2? Just give me the answer.");

        System.out.println("\n=== 测试结果 ===");
        System.out.println("成功: " + result.success);
        if (!result.success && result.error != null) {
            System.out.println("错误: " + result.error);
        }
        System.out.println();
    }

    /**
     * 主方法 - 运行测试
     */
    public static void main(String[] args) {
        ClaudeSDKTest test = new ClaudeSDKTest();

        if (args.length > 0) {
            // 如果提供了参数，直接执行查询
            String prompt = String.join(" ", args);
            System.out.println("执行自定义查询: " + prompt);
            SDKResult result = test.executeQuery(prompt);
            System.out.println("\n结果: " + (result.success ? "成功" : "失败"));
            if (result.error != null) {
                System.out.println("错误: " + result.error);
            }
        } else {
            // 运行完整测试
            test.runFullTest();
        }
    }
}
