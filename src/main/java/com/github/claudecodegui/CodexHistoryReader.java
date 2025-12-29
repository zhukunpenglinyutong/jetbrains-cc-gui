package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Codex 本地历史记录读取器
 * 从 ~/.codex/sessions 目录读取 Codex CLI 的会话历史
 */
public class CodexHistoryReader {

    private static final Logger LOG = Logger.getInstance(CodexHistoryReader.class);

    private static final String HOME_DIR = System.getProperty("user.home");
    private static final Path CODEX_SESSIONS_DIR = Paths.get(HOME_DIR, ".codex", "sessions");

    private final Gson gson = new Gson();

    /**
     * 会话信息
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd; // 工作目录路径
    }

    /**
     * 会话消息（Codex格式）
     */
    public static class CodexMessage {
        public String timestamp;
        public String type;
        public JsonObject payload;
    }

    /**
     * 读取所有 Codex 会话
     * 不区分项目，返回所有会话
     */
    public List<SessionInfo> readAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();

        if (!Files.exists(CODEX_SESSIONS_DIR) || !Files.isDirectory(CODEX_SESSIONS_DIR)) {
            LOG.info("[CodexHistoryReader] Codex sessions directory not found: " + CODEX_SESSIONS_DIR);
            return sessions;
        }

        // 递归遍历所有 .jsonl 文件
        try (Stream<Path> paths = Files.walk(CODEX_SESSIONS_DIR)) {
            List<Path> jsonlFiles = paths
                .filter(Files::isRegularFile)
                .filter(path -> path.toString().endsWith(".jsonl"))
                .filter(path -> {
                    try {
                        return Files.size(path) > 0;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Found " + jsonlFiles.size() + " Codex session files");

            for (Path sessionFile : jsonlFiles) {
                try {
                    SessionInfo session = parseSessionFile(sessionFile);
                    if (session != null && isValidSession(session)) {
                        sessions.add(session);
                    }
                } catch (Exception e) {
                    LOG.warn("[CodexHistoryReader] Failed to parse session file: " + sessionFile + " - " + e.getMessage());
                }
            }
        }

        // 按时间戳倒序排序
        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        LOG.info("[CodexHistoryReader] Successfully loaded " + sessions.size() + " valid Codex sessions");
        return sessions;
    }

    /**
     * 解析单个会话文件
     */
    private SessionInfo parseSessionFile(Path sessionFile) throws IOException {
        SessionInfo session = new SessionInfo();

        // 从文件名提取 sessionId
        String fileName = sessionFile.getFileName().toString();
        session.sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

        List<CodexMessage> messages = new ArrayList<>();
        String sessionMeta = null;
        int messageCount = 0;

        try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    CodexMessage msg = gson.fromJson(line, CodexMessage.class);
                    if (msg != null) {
                        messages.add(msg);

                        // 提取 session_meta 信息
                        if ("session_meta".equals(msg.type) && msg.payload != null) {
                            sessionMeta = msg.payload.toString();

                            // 提取 cwd
                            if (msg.payload.has("cwd")) {
                                session.cwd = msg.payload.get("cwd").getAsString();
                            }

                            // 提取 timestamp
                            if (msg.payload.has("timestamp")) {
                                try {
                                    String ts = msg.payload.get("timestamp").getAsString();
                                    session.firstTimestamp = parseTimestamp(ts);
                                    session.lastTimestamp = session.firstTimestamp;
                                } catch (Exception e) {
                                    // 忽略时间戳解析错误
                                }
                            }
                        }

                        // 统计有效消息数
                        if ("response_item".equals(msg.type)) {
                            messageCount++;
                        }

                        // 更新最后时间戳
                        if (msg.timestamp != null) {
                            try {
                                long ts = parseTimestamp(msg.timestamp);
                                if (ts > session.lastTimestamp) {
                                    session.lastTimestamp = ts;
                                }
                            } catch (Exception e) {
                                // 忽略时间戳解析错误
                            }
                        }
                    }
                } catch (Exception e) {
                    // 跳过解析失败的行
                    LOG.debug("[CodexHistoryReader] Failed to parse line: " + e.getMessage());
                }
            }
        }

        session.messageCount = messageCount;

        // 生成标题
        session.title = generateTitle(messages);

        return session;
    }

    /**
     * 生成会话标题
     * 从第一条 event_msg (type: user_message) 的 message 字段提取内容
     */
    private String generateTitle(List<CodexMessage> messages) {
        for (CodexMessage msg : messages) {
            // 查找 type: "event_msg" 的消息
            if ("event_msg".equals(msg.type) && msg.payload != null) {
                JsonObject payload = msg.payload;

                // 检查是否是 user_message 类型
                if (payload.has("type") && "user_message".equals(payload.get("type").getAsString())) {
                    // 提取 message 字段
                    if (payload.has("message")) {
                        String text = payload.get("message").getAsString();
                        if (text != null && !text.isEmpty()) {
                            // 去除换行符并截断
                            text = text.replace("\n", " ").trim();
                            if (text.length() > 45) {
                                text = text.substring(0, 45) + "...";
                            }
                            return text;
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * 从 content 提取文本
     */
    private String extractTextFromContent(JsonElement contentElem) {
        if (contentElem == null) {
            return null;
        }

        // 处理字符串类型
        if (contentElem.isJsonPrimitive()) {
            return contentElem.getAsString();
        }

        // 处理数组类型
        if (contentElem.isJsonArray()) {
            JsonArray contentArray = contentElem.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    JsonObject itemObj = item.getAsJsonObject();

                    // 提取文本类型
                    if (itemObj.has("type") && "text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append(" ");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // 提取 input_text 类型 (Codex 特有)
                    else if (itemObj.has("type") && "input_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append(" ");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                }
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        }

        return null;
    }

    /**
     * 判断会话是否有效
     */
    private boolean isValidSession(SessionInfo session) {
        // 过滤标题为空的会话
        if (session.title == null || session.title.isEmpty()) {
            return false;
        }

        // 过滤消息数太少的会话
        if (session.messageCount < 1) {
            return false;
        }

        return true;
    }

    /**
     * 解析时间戳（ISO 8601 格式）
     */
    private long parseTimestamp(String timestamp) {
        try {
            java.time.Instant instant = java.time.Instant.parse(timestamp);
            return instant.toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * 获取所有会话的 JSON 字符串
     */
    public String getAllSessionsAsJson() {
        try {
            List<SessionInfo> sessions = readAllSessions();

            // 计算总消息数
            int totalMessages = sessions.stream()
                .mapToInt(s -> s.messageCount)
                .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "读取 Codex 会话失败: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * 判断命令是否为文件/目录查看操作
     */
    private boolean isFileViewingCommand(String command) {
        if (command == null || command.isEmpty()) {
            return false;
        }
        String trimmed = command.trim();
        // File viewing: pwd, ls, cat, head, tail, sed -n, tree, file, stat
        return trimmed.matches("^(pwd|ls|cat|head|tail|tree|file|stat)\\b.*") ||
               trimmed.matches("^sed\\s+-n\\s+.*");
    }

    /**
     * 转换 Codex function_call 为 Claude 兼容格式
     * 将文件查看命令的 shell_command 转换为 read 工具
     */
    private CodexMessage transformFunctionCall(CodexMessage msg) {
        if (msg == null || !"response_item".equals(msg.type) || msg.payload == null) {
            return msg;
        }

        JsonObject payload = msg.payload;

        // 检查是否为 function_call
        if (!payload.has("type") || !"function_call".equals(payload.get("type").getAsString())) {
            return msg;
        }

        // 检查是否为 shell_command
        if (!payload.has("name") || !"shell_command".equals(payload.get("name").getAsString())) {
            return msg;
        }

        // 提取 arguments
        if (!payload.has("arguments")) {
            return msg;
        }

        try {
            String argumentsStr = payload.get("arguments").getAsString();
            JsonObject arguments = gson.fromJson(argumentsStr, JsonObject.class);

            if (arguments != null && arguments.has("command")) {
                String command = arguments.get("command").getAsString();

                // 如果是文件查看命令，转换为 read 工具
                if (isFileViewingCommand(command)) {
                    payload.addProperty("name", "read");
                    LOG.debug("[CodexHistoryReader] Transformed shell_command to read for: " + command);
                }
            }
        } catch (Exception e) {
            LOG.debug("[CodexHistoryReader] Failed to parse arguments: " + e.getMessage());
        }

        return msg;
    }

    /**
     * 读取单个会话的所有消息
     */
    public String getSessionMessagesAsJson(String sessionId) {
        try {
            // 查找会话文件
            Path sessionFile = findSessionFile(sessionId);
            if (sessionFile == null) {
                LOG.warn("[CodexHistoryReader] Session file not found for: " + sessionId);
                return gson.toJson(new ArrayList<>());
            }

            List<CodexMessage> messages = new ArrayList<>();

            try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;

                    try {
                        CodexMessage msg = gson.fromJson(line, CodexMessage.class);
                        if (msg != null) {
                            // 转换 function_call（shell_command -> read）
                            msg = transformFunctionCall(msg);
                            messages.add(msg);
                        }
                    } catch (Exception e) {
                        LOG.debug("[CodexHistoryReader] Failed to parse message: " + e.getMessage());
                    }
                }
            }

            return gson.toJson(messages);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read session messages: " + e.getMessage(), e);
            return gson.toJson(new ArrayList<>());
        }
    }

    /**
     * 查找会话文件
     */
    private Path findSessionFile(String sessionId) throws IOException {
        if (!Files.exists(CODEX_SESSIONS_DIR)) {
            return null;
        }

        try (Stream<Path> paths = Files.walk(CODEX_SESSIONS_DIR)) {
            return paths
                .filter(Files::isRegularFile)
                .filter(path -> path.getFileName().toString().startsWith(sessionId))
                .filter(path -> path.toString().endsWith(".jsonl"))
                .findFirst()
                .orElse(null);
        }
    }
}
