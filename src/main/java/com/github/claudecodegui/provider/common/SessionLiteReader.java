package com.github.claudecodegui.provider.common;

import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * Lightweight session file reader that only reads head and tail chunks.
 * Provides efficient metadata extraction without full JSONL parsing.
 * <p>
 * Buffer size: 64KB (same as Claude CLI's LITE_READ_BUF_SIZE).
 */
public class SessionLiteReader {

    private static final Logger LOG = Logger.getInstance(SessionLiteReader.class);

    private static final Gson GSON = new Gson();

    /**
     * Size of the head/tail buffer for lite metadata reads (64KB).
     */
    public static final int LITE_READ_BUF_SIZE = 65536;

    /**
     * Lite session file data structure.
     */
    public static class LiteSessionFile {
        public final long mtime;
        public final long size;
        public final String head;
        public final String tail;

        public LiteSessionFile(long mtime, long size, String head, String tail) {
            this.mtime = mtime;
            this.size = size;
            this.head = head;
            this.tail = tail;
        }
    }

    /**
     * Reads the first and last LITE_READ_BUF_SIZE bytes of a file.
     * For small files where head covers tail, returns same content for both.
     *
     * @param path the file path to read
     * @return LiteSessionFile with head and tail content, or null on error
     */
    public LiteSessionFile readSessionLite(Path path) {
        try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ)) {
            long fileSize = channel.size();
            long mtime = java.nio.file.Files.getLastModifiedTime(path).toMillis();

            if (fileSize == 0) {
                return null;
            }

            ByteBuffer buffer = ByteBuffer.allocate(LITE_READ_BUF_SIZE);

            // Read head
            buffer.clear();
            int headBytesRead = channel.read(buffer, 0);
            if (headBytesRead <= 0) {
                return null;
            }
            String head = new String(buffer.array(), 0, headBytesRead, StandardCharsets.UTF_8);

            // Read tail (if file is large enough)
            String tail = head;
            long tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE);
            if (tailOffset > 0) {
                buffer.clear();
                int tailBytesRead = channel.read(buffer, tailOffset);
                if (tailBytesRead > 0) {
                    tail = new String(buffer.array(), 0, tailBytesRead, StandardCharsets.UTF_8);
                }
            }

            return new LiteSessionFile(mtime, fileSize, head, tail);
        } catch (IOException e) {
            LOG.debug("[SessionLiteReader] Failed to read file: " + path + " - " + e.getMessage());
            return null;
        }
    }

    /**
     * Extracts a JSON string field value from raw text without full parsing.
     * Looks for "key":"value" or "key": "value" patterns.
     * Returns the first match, or null if not found.
     *
     * @param text the text to search
     * @param key  the JSON key to find
     * @return the extracted string value, or null
     */
    public String extractJsonStringField(String text, String key) {
        if (text == null || key == null) {
            return null;
        }

        String[] patterns = {"\"" + key + "\":\"", "\"" + key + "\": \""};
        for (String pattern : patterns) {
            int idx = text.indexOf(pattern);
            if (idx < 0) {
                continue;
            }

            int valueStart = idx + pattern.length();
            int i = valueStart;
            while (i < text.length()) {
                char c = text.charAt(i);
                if (c == '\\') {
                    i += 2;
                    continue;
                }
                if (c == '"') {
                    String rawValue = text.substring(valueStart, i);
                    return unescapeJsonString(rawValue);
                }
                i++;
            }
        }
        return null;
    }

    /**
     * Like extractJsonStringField but finds the LAST occurrence.
     * Useful for fields that are appended (customTitle, tag, etc.).
     *
     * @param text the text to search
     * @param key  the JSON key to find
     * @return the last extracted string value, or null
     */
    public String extractLastJsonStringField(String text, String key) {
        if (text == null || key == null) {
            return null;
        }

        String[] patterns = {"\"" + key + "\":\"", "\"" + key + "\": \""};
        String lastValue = null;
        for (String pattern : patterns) {
            int searchFrom = 0;
            while (true) {
                int idx = text.indexOf(pattern, searchFrom);
                if (idx < 0) {
                    break;
                }

                int valueStart = idx + pattern.length();
                int i = valueStart;
                while (i < text.length()) {
                    char c = text.charAt(i);
                    if (c == '\\') {
                        i += 2;
                        continue;
                    }
                    if (c == '"') {
                        String rawValue = text.substring(valueStart, i);
                        lastValue = unescapeJsonString(rawValue);
                        break;
                    }
                    i++;
                }
                searchFrom = i + 1;
            }
        }
        return lastValue;
    }

    /**
     * Unescape a JSON string value extracted as raw text.
     * Only allocates a new string when escape sequences are present.
     *
     * @param raw the raw string with possible escape sequences
     * @return the unescaped string
     */
    private String unescapeJsonString(String raw) {
        if (raw == null || !raw.contains("\\")) {
            return raw;
        }
        try {
            return GSON.fromJson("\"" + raw + "\"", String.class);
        } catch (Exception e) {
            return raw;
        }
    }

    /**
     * Checks if the first line indicates a sidechain session.
     *
     * @param head the head chunk content
     * @return true if the session is a sidechain
     */
    public boolean isSidechainSession(String head) {
        if (head == null || head.isEmpty()) {
            return false;
        }

        int firstNewline = head.indexOf('\n');
        String firstLine = firstNewline >= 0 ? head.substring(0, firstNewline) : head;

        return firstLine.contains("\"isSidechain\":true") ||
               firstLine.contains("\"isSidechain\": true");
    }

    /**
     * Extracts the first meaningful user prompt from a JSONL head chunk.
     * Skips tool_result, isMeta, isCompactSummary, and auto-generated patterns.
     * Supports both string content and array content formats.
     *
     * @param head the head chunk content
     * @return the extracted prompt, truncated to 200 chars, or null
     */
    public String extractFirstPromptFromHead(String head) {
        if (head == null || head.isEmpty()) {
            return null;
        }

        int start = 0;
        String commandFallback = null;

        while (start < head.length()) {
            int newlineIdx = head.indexOf('\n', start);
            String line = newlineIdx >= 0 ? head.substring(start, newlineIdx) : head.substring(start);
            start = newlineIdx >= 0 ? newlineIdx + 1 : head.length();

            if (!line.contains("\"type\":\"user\"") && !line.contains("\"type\": \"user\"")) {
                continue;
            }
            if (line.contains("\"tool_result\"")) {
                continue;
            }
            if (line.contains("\"isMeta\":true") || line.contains("\"isMeta\": true")) {
                continue;
            }
            if (line.contains("\"isCompactSummary\":true") || line.contains("\"isCompactSummary\": true")) {
                continue;
            }

            // Try to extract the text content (supports both string and array formats)
            String contentText = this.extractContentFromLine(line);
            if (contentText != null && !contentText.isEmpty()) {
                String result = contentText.replace("\n", " ").trim();

                // Check for slash-command pattern
                if (result.startsWith("<command-name>") && result.contains("</command-name>")) {
                    int nameStart = result.indexOf("<command-name>") + 14;
                    int nameEnd = result.indexOf("</command-name>");
                    if (nameEnd > nameStart) {
                        commandFallback = result.substring(nameStart, nameEnd);
                        continue;
                    }
                }

                // Check for bash-input pattern
                if (result.contains("<bash-input>")) {
                    int bashStart = result.indexOf("<bash-input>") + 12;
                    int bashEnd = result.indexOf("</bash-input>");
                    if (bashEnd > bashStart) {
                        return "! " + result.substring(bashStart, bashEnd).trim();
                    }
                }

                // Skip auto-generated patterns (IDE context, hook output, etc.)
                if (result.startsWith("<") && result.length() > 1) {
                    char nextChar = result.charAt(1);
                    if (Character.isLowerCase(nextChar)) {
                        continue;  // Skip lowercase XML tags like <ide-context>
                    }
                }

                if (result.startsWith("[Request interrupted")) {
                    continue;
                }

                // Truncate to 200 chars
                if (result.length() > 200) {
                    result = result.substring(0, 200).trim() + "\u2026";
                }
                return result;
            }
        }

        return commandFallback;
    }

    /**
     * Extracts text content from a JSON line, supporting both string and array formats.
     * First tries string format "content":"...", then falls back to JSON parsing for array format.
     *
     * @param line the JSON line to parse
     * @return extracted text content, or null
     */
    private String extractContentFromLine(String line) {
        // First try simple string extraction: "content":"..."
        String content = this.extractJsonStringField(line, "content");
        if (content != null && !content.isEmpty()) {
            return content;
        }

        // Fallback: parse JSON for array format content
        // Content array format: [{"type":"text","text":"actual text"},...]
        if (line.contains("\"content\":[") || line.contains("\"content\": [")) {
            try {
                com.google.gson.JsonObject entry = GSON.fromJson(line, com.google.gson.JsonObject.class);
                if (entry == null || !entry.has("message")) {
                    return null;
                }

                com.google.gson.JsonElement messageElem = entry.get("message");
                if (messageElem == null || !messageElem.isJsonObject()) {
                    return null;
                }

                com.google.gson.JsonObject message = messageElem.getAsJsonObject();
                if (!message.has("content")) {
                    return null;
                }

                com.google.gson.JsonElement contentElem = message.get("content");
                if (contentElem.isJsonArray()) {
                    // Array format: extract text from type:"text" blocks
                    com.google.gson.JsonArray contentArray = contentElem.getAsJsonArray();
                    StringBuilder sb = new StringBuilder();
                    for (com.google.gson.JsonElement block : contentArray) {
                        if (block.isJsonObject()) {
                            com.google.gson.JsonObject blockObj = block.getAsJsonObject();
                            if (blockObj.has("type") && "text".equals(blockObj.get("type").getAsString())) {
                                if (blockObj.has("text") && !blockObj.get("text").isJsonNull()) {
                                    if (sb.length() > 0) {
                                        sb.append(" ");
                                    }
                                    sb.append(blockObj.get("text").getAsString());
                                }
                            }
                        }
                    }
                    String result = sb.toString().trim();
                    return result.isEmpty() ? null : result;
                } else if (contentElem.isJsonPrimitive()) {
                    // String format (already handled above, but just in case)
                    return contentElem.getAsString();
                }
            } catch (Exception e) {
                // JSON parsing failed, return null
            }
        }

        return null;
    }

    /**
     * Counts message entries in the head chunk by counting non-empty lines.
     * This is an approximation - only counts messages visible in head chunk.
     * For large files (exceeding LITE_READ_BUF_SIZE), messages in tail are not counted.
     *
     * @param head the head chunk content
     * @return approximate message count (messages in head only)
     */
    public int countMessagesInHead(String head) {
        if (head == null || head.isEmpty()) {
            return 0;
        }

        int count = 0;
        int start = 0;
        while (start < head.length()) {
            int newlineIdx = head.indexOf('\n', start);
            String line = newlineIdx >= 0 ? head.substring(start, newlineIdx) : head.substring(start);
            start = newlineIdx >= 0 ? newlineIdx + 1 : head.length();

            if (line.trim().isEmpty()) {
                continue;
            }

            // Skip sidechain messages in count
            if (line.contains("\"isSidechain\":true") || line.contains("\"isSidechain\": true")) {
                continue;
            }

            count++;
        }
        return count;
    }
}