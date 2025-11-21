package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonParser;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Claude本地历史记录读取器
 * 直接从本地文件系统读取Claude的历史数据
 */
public class ClaudeHistoryReader {

    private static final String HOME_DIR = System.getProperty("user.home");
    private static final Path CLAUDE_DIR = Paths.get(HOME_DIR, ".claude");
    private static final Path HISTORY_FILE = CLAUDE_DIR.resolve("history.jsonl");
    private static final Path PROJECTS_DIR = CLAUDE_DIR.resolve("projects");

    private final Gson gson = new Gson();

    /**
     * 历史记录条目
     */
    public static class HistoryEntry {
        public String display;
        public Map<String, Object> pastedContents;
        public long timestamp;
        public String project;
        public String sessionId;

        public HistoryEntry() {
            this.pastedContents = new HashMap<>();
        }
    }

    /**
     * 项目信息
     */
    public static class ProjectInfo {
        public String path;
        public String name;
        public int count;
        public long lastAccess;
        public List<HistoryEntry> messages;

        public ProjectInfo(String path) {
            this.path = path;
            this.name = path != null ? Paths.get(path).getFileName().toString() : "Root";
            if (this.name.isEmpty()) {
                this.name = "Root";
            }
            this.count = 0;
            this.lastAccess = 0;
            this.messages = new ArrayList<>();
        }
    }

    /**
     * 会话消息（从 projects 目录读取）
     */
    public static class ConversationMessage {
        public String uuid;
        public String sessionId;
        public String parentUuid;
        public String timestamp;
        public String type;
        public Message message;
        public Boolean isMeta;
        public Boolean isSidechain;
        public String cwd;

        public static class Message {
            public String role;
            public Object content; // 可能是 String 或 Array
        }
    }

    /**
     * 从 projects 目录读取项目的所有会话
     */
    public List<SessionInfo> readProjectSessions(String projectPath) throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();

        if (projectPath == null || projectPath.isEmpty()) {
            return sessions;
        }

        // 转换项目路径为安全的目录名（与 VSCode 扩展逻辑一致）
        String sanitizedPath = projectPath.replaceAll("[^a-zA-Z0-9]", "-");
        Path projectDir = PROJECTS_DIR.resolve(sanitizedPath);

        if (!Files.exists(projectDir) || !Files.isDirectory(projectDir)) {
            return sessions;
        }

        // 读取项目目录下所有 .jsonl 文件
        Map<String, List<ConversationMessage>> sessionMessagesMap = new HashMap<>();

        Files.list(projectDir)
            .filter(path -> path.toString().endsWith(".jsonl"))
            .filter(path -> {
                try {
                    return Files.size(path) > 0;
                } catch (IOException e) {
                    return false;
                }
            })
            .forEach(path -> {
                try (BufferedReader reader = Files.newBufferedReader(path)) {
                    // 从文件名提取 sessionId
                    String fileName = path.getFileName().toString();
                    String sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

                    List<ConversationMessage> messages = new ArrayList<>();
                    String line;

                    while ((line = reader.readLine()) != null) {
                        if (line.trim().isEmpty()) continue;

                        try {
                            ConversationMessage msg = gson.fromJson(line, ConversationMessage.class);
                            if (msg != null) {
                                messages.add(msg);
                            }
                        } catch (Exception e) {
                            // 跳过解析失败的行
                        }
                    }

                    if (!messages.isEmpty()) {
                        sessionMessagesMap.put(sessionId, messages);
                    }

                } catch (Exception e) {
                    System.err.println("读取对话文件失败: " + path + " - " + e.getMessage());
                }
            });

        // 为每个会话生成 SessionInfo
        for (Map.Entry<String, List<ConversationMessage>> entry : sessionMessagesMap.entrySet()) {
            String sessionId = entry.getKey();
            List<ConversationMessage> messages = entry.getValue();

            if (messages.isEmpty()) continue;

            // 生成摘要：找到第一条非 meta 的用户消息
            String summary = generateSummary(messages);

            // 获取最后一条消息的时间戳
            long lastTimestamp = 0;
            for (ConversationMessage msg : messages) {
                if (msg.timestamp != null) {
                    try {
                        long ts = parseTimestamp(msg.timestamp);
                        if (ts > lastTimestamp) {
                            lastTimestamp = ts;
                        }
                    } catch (Exception e) {
                        // 忽略无效的时间戳
                    }
                }
            }

            // 过滤无效会话
            if (!isValidSession(sessionId, summary, messages.size())) {
                continue;
            }

            SessionInfo session = new SessionInfo();
            session.sessionId = sessionId;
            session.title = summary;
            session.messageCount = messages.size();
            session.lastTimestamp = lastTimestamp;
            session.firstTimestamp = lastTimestamp; // 简化处理

            sessions.add(session);
        }

        // 按最后更新时间倒序排序
        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        return sessions;
    }

    /**
     * 生成会话摘要
     */
    private String generateSummary(List<ConversationMessage> messages) {
        for (ConversationMessage msg : messages) {
            if ("user".equals(msg.type) &&
                (msg.isMeta == null || !msg.isMeta) &&
                msg.message != null &&
                msg.message.content != null) {

                String text = extractTextFromContent(msg.message.content);
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
        return null; // 返回 null 表示没有有效内容
    }

    /**
     * 判断会话是否有效（过滤掉 Warmup、No prompt 等无效会话）
     */
    private boolean isValidSession(String sessionId, String summary, int messageCount) {
        // 过滤 agent-xxx 格式的会话（都是 Warmup）
        if (sessionId != null && sessionId.startsWith("agent-")) {
            return false;
        }

        // 过滤摘要为空或无效的会话
        if (summary == null || summary.isEmpty()) {
            return false;
        }

        // 过滤只有 "Warmup" 或 "No prompt" 的会话
        String lowerSummary = summary.toLowerCase();
        if (lowerSummary.equals("warmup") ||
            lowerSummary.equals("no prompt") ||
            lowerSummary.startsWith("warmup") ||
            lowerSummary.startsWith("no prompt")) {
            return false;
        }

        // 过滤消息数太少的会话（少于2条消息通常没什么内容）
        if (messageCount < 2) {
            return false;
        }

        return true;
    }

    /**
     * 从 content 提取文本
     */
    private String extractTextFromContent(Object content) {
        // 处理 String 类型
        if (content instanceof String) {
            return (String) content;
        }
        // 处理 List 类型（这是实际的格式）
        else if (content instanceof List) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> contentList = (List<Map<String, Object>>) content;
            StringBuilder sb = new StringBuilder();

            // 遍历所有内容项
            for (Map<String, Object> item : contentList) {
                String type = (String) item.get("type");

                // 处理文本类型
                if ("text".equals(type)) {
                    Object text = item.get("text");
                    if (text instanceof String) {
                        if (sb.length() > 0) {
                            sb.append(" ");
                        }
                        sb.append((String) text);
                    }
                }
                // 处理工具使用类型
                else if ("tool_use".equals(type)) {
                    Object name = item.get("name");
                    if (name instanceof String && sb.length() == 0) {
                        // 如果还没有文本内容，显示工具使用信息
                        sb.append("[使用工具: ").append(name).append("]");
                    }
                }
                // 可以根据需要添加其他类型的处理
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        }
        // 处理 com.google.gson.JsonArray 类型（从 Gson 解析）
        else if (content instanceof com.google.gson.JsonArray) {
            com.google.gson.JsonArray contentArray = (com.google.gson.JsonArray) content;
            StringBuilder sb = new StringBuilder();

            for (int i = 0; i < contentArray.size(); i++) {
                com.google.gson.JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    com.google.gson.JsonObject item = element.getAsJsonObject();

                    // 获取类型
                    String type = item.has("type") && !item.get("type").isJsonNull()
                        ? item.get("type").getAsString()
                        : null;

                    // 处理文本类型
                    if ("text".equals(type) && item.has("text") && !item.get("text").isJsonNull()) {
                        if (sb.length() > 0) {
                            sb.append(" ");
                        }
                        sb.append(item.get("text").getAsString());
                    }
                    // 处理工具使用类型
                    else if ("tool_use".equals(type) && item.has("name") && !item.get("name").isJsonNull()) {
                        if (sb.length() == 0) {
                            sb.append("[使用工具: ").append(item.get("name").getAsString()).append("]");
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
     * 解析时间戳（支持 ISO 8601 格式）
     */
    private long parseTimestamp(String timestamp) {
        try {
            // ISO 8601 格式如 "2025-11-18T20:16:42.310Z"
            java.time.Instant instant = java.time.Instant.parse(timestamp);
            return instant.toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * 会话信息
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
    }

    /**
     * 统计信息
     */
    public static class Statistics {
        public int totalMessages;
        public int totalProjects;
        public HistoryEntry firstMessage;
        public HistoryEntry lastMessage;
        public Map<String, Integer> messagesByDay;

        public Statistics() {
            this.messagesByDay = new HashMap<>();
        }
    }

    /**
     * API响应
     */
    public static class ApiResponse {
        public boolean success;
        public String error;
        public Object data;

        public static ApiResponse success(Object data) {
            ApiResponse response = new ApiResponse();
            response.success = true;
            response.data = data;
            return response;
        }

        public static ApiResponse error(String message) {
            ApiResponse response = new ApiResponse();
            response.success = false;
            response.error = message;
            return response;
        }
    }

    /**
     * 读取所有历史记录
     */
    public List<HistoryEntry> readHistory() throws IOException {
        List<HistoryEntry> history = new ArrayList<>();

        if (!Files.exists(HISTORY_FILE)) {
            return history;
        }

        try (BufferedReader reader = Files.newBufferedReader(HISTORY_FILE)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.trim().isEmpty()) {
                    try {
                        HistoryEntry entry = gson.fromJson(line, HistoryEntry.class);
                        if (entry != null) {
                            history.add(entry);
                        }
                    } catch (Exception e) {
                        System.err.println("解析行失败: " + e.getMessage());
                    }
                }
            }
        }

        // 按时间戳排序（最新的在前）
        history.sort((a, b) -> Long.compare(b.timestamp, a.timestamp));

        return history;
    }

    /**
     * 获取项目列表
     */
    public List<ProjectInfo> getProjects(List<HistoryEntry> history) {
        Map<String, ProjectInfo> projectsMap = new HashMap<>();

        for (HistoryEntry entry : history) {
            if (entry.project != null) {
                ProjectInfo project = projectsMap.computeIfAbsent(
                    entry.project,
                    ProjectInfo::new
                );
                project.count++;
                project.messages.add(entry);
                if (entry.timestamp > project.lastAccess) {
                    project.lastAccess = entry.timestamp;
                }
            }
        }

        return projectsMap.values().stream()
            .sorted((a, b) -> Long.compare(b.lastAccess, a.lastAccess))
            .collect(Collectors.toList());
    }

    /**
     * 获取统计信息
     */
    public Statistics getStatistics(List<HistoryEntry> history) {
        Statistics stats = new Statistics();
        stats.totalMessages = history.size();

        if (!history.isEmpty()) {
            // 获取第一条和最后一条消息
            List<HistoryEntry> sorted = new ArrayList<>(history);
            sorted.sort(Comparator.comparingLong(e -> e.timestamp));
            stats.firstMessage = sorted.get(0);
            stats.lastMessage = sorted.get(sorted.size() - 1);

            // 统计项目数
            Set<String> projects = history.stream()
                .map(e -> e.project)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
            stats.totalProjects = projects.size();

            // 按天统计消息
            for (HistoryEntry entry : history) {
                if (entry.timestamp > 0) {
                    Date date = new Date(entry.timestamp);
                    String dateStr = String.format("%tF", date);
                    stats.messagesByDay.merge(dateStr, 1, Integer::sum);
                }
            }
        }

        return stats;
    }

    /**
     * 搜索历史记录
     */
    public List<HistoryEntry> searchHistory(List<HistoryEntry> history, String query) {
        if (query == null || query.trim().isEmpty()) {
            return history;
        }

        String lowerQuery = query.toLowerCase();
        return history.stream()
            .filter(entry -> {
                String display = entry.display != null ? entry.display.toLowerCase() : "";
                return display.contains(lowerQuery);
            })
            .limit(100)
            .collect(Collectors.toList());
    }

    /**
     * 读取项目详情
     */
    public Map<String, Object> getProjectDetails(String projectPath) {
        Map<String, Object> details = new HashMap<>();
        details.put("path", projectPath);
        details.put("exists", false);
        details.put("conversations", new ArrayList<>());

        if (projectPath == null || projectPath.isEmpty()) {
            return details;
        }

        // 将路径转换为文件系统安全的名称
        String sanitizedPath = projectPath.replace("/", "-");
        Path projectDir = PROJECTS_DIR.resolve(sanitizedPath);

        if (Files.exists(projectDir) && Files.isDirectory(projectDir)) {
            details.put("exists", true);

            try {
                List<Map<String, Object>> conversations = new ArrayList<>();

                // 读取项目目录中的对话文件
                Files.list(projectDir)
                    .filter(Files::isDirectory)
                    .forEach(subDir -> {
                        Path convFile = subDir.resolve("conversation.json");
                        if (Files.exists(convFile)) {
                            try {
                                String content = new String(Files.readAllBytes(convFile));
                                Map<String, Object> convData = new HashMap<>();
                                convData.put("id", subDir.getFileName().toString());
                                convData.put("data", JsonParser.parseString(content));
                                convData.put("timestamp", Files.getLastModifiedTime(convFile).toMillis());
                                conversations.add(convData);
                            } catch (Exception e) {
                                System.err.println("读取对话文件失败: " + e.getMessage());
                            }
                        }
                    });

                details.put("conversations", conversations);
            } catch (IOException e) {
                System.err.println("读取项目详情失败: " + e.getMessage());
            }
        }

        return details;
    }

    /**
     * 获取指定项目的历史记录JSON字符串
     */
    public String getProjectDataAsJson(String projectPath) {
        try {
            // 从 projects 目录读取会话列表
            List<SessionInfo> sessions = readProjectSessions(projectPath);

            // 计算总消息数
            int totalMessages = sessions.stream()
                .mapToInt(s -> s.messageCount)
                .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("currentProject", projectPath);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            return gson.toJson(ApiResponse.error("读取项目数据失败: " + e.getMessage()));
        }
    }

    /**
     * 获取所有数据的JSON字符串
     */
    public String getAllDataAsJson() {
        try {
            List<HistoryEntry> history = readHistory();
            List<ProjectInfo> projects = getProjects(history);
            Statistics stats = getStatistics(history);

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("history", history.size() > 200 ? history.subList(0, 200) : history);
            result.put("projects", projects);
            result.put("stats", stats);
            result.put("total", history.size());

            return gson.toJson(result);
        } catch (Exception e) {
            return gson.toJson(ApiResponse.error("读取数据失败: " + e.getMessage()));
        }
    }

    /**
     * 处理API请求
     */
    public String handleApiRequest(String endpoint, Map<String, String> params) {
        try {
            switch (endpoint) {
                case "/history":
                    return getAllDataAsJson();

                case "/stats":
                    List<HistoryEntry> historyForStats = readHistory();
                    Statistics stats = getStatistics(historyForStats);
                    return gson.toJson(ApiResponse.success(stats));

                case "/search":
                    String query = params.get("q");
                    List<HistoryEntry> historyForSearch = readHistory();
                    List<HistoryEntry> searchResults = searchHistory(historyForSearch, query);
                    Map<String, Object> searchResponse = new HashMap<>();
                    searchResponse.put("query", query);
                    searchResponse.put("count", searchResults.size());
                    searchResponse.put("results", searchResults);
                    return gson.toJson(ApiResponse.success(searchResponse));

                case "/project":
                    String projectPath = params.get("path");
                    Map<String, Object> projectDetails = getProjectDetails(projectPath);
                    return gson.toJson(ApiResponse.success(projectDetails));

                default:
                    return gson.toJson(ApiResponse.error("Unknown endpoint: " + endpoint));
            }
        } catch (Exception e) {
            return gson.toJson(ApiResponse.error("处理请求失败: " + e.getMessage()));
        }
    }

    /**
     * 主方法用于测试
     */
    public static void main(String[] args) {
        ClaudeHistoryReader reader = new ClaudeHistoryReader();

        try {
            // 测试读取历史
            List<HistoryEntry> history = reader.readHistory();
            System.out.println("历史记录条数: " + history.size());

            // 测试获取项目
            List<ProjectInfo> projects = reader.getProjects(history);
            System.out.println("项目数: " + projects.size());

            // 测试获取统计
            Statistics stats = reader.getStatistics(history);
            System.out.println("总消息数: " + stats.totalMessages);
            System.out.println("总项目数: " + stats.totalProjects);

            // 输出JSON
            System.out.println("\nJSON输出:");
            System.out.println(reader.getAllDataAsJson());

        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
