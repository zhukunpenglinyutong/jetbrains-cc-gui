package com.github.claudecodegui.cli.common;

import java.util.List;
import java.util.Set;

/**
 * CLI 包全局常量：集中管理 provider 标识、消息类型、CLI 参数、环境变量名、sandbox 模式等魔法字符串。
 */
public final class CliConstants {

    private CliConstants() {
    }

    // ── Provider 标识 ──────────────────────────────────────────────────────────

    public static final String PROVIDER_CLAUDE = "claude";
    public static final String PROVIDER_CODEX = "codex";

    // ── I18N 消息键 ────────────────────────────────────────────────────────────

    public static final String I18N_REQUEST_INTERRUPTED = "__I18N__:chat.requestInterrupted";
    public static final String I18N_UNSUPPORTED_IMAGE = "__I18N__:aiBridge.unsupportedImageVision";

    // ── 回调消息类型 ───────────────────────────────────────────────────────────

    public static final String MSG_SESSION_ID = "session_id";
    public static final String MSG_STREAM_START = "stream_start";
    public static final String MSG_STREAM_END = "stream_end";
    public static final String MSG_MESSAGE_START = "message_start";
    public static final String MSG_MESSAGE_END = "message_end";
    public static final String MSG_CONTENT_DELTA = "content_delta";
    public static final String MSG_THINKING = "thinking";
    public static final String MSG_THINKING_DELTA = "thinking_delta";
    public static final String MSG_BLOCK_RESET = "block_reset";
    public static final String MSG_USAGE = "usage";
    public static final String MSG_RESULT = "result";
    public static final String MSG_ASSISTANT = "assistant";
    public static final String MSG_USER = "user";

    // ── Claude CLI 参数 ────────────────────────────────────────────────────────

    public static final String ARG_P = "-p";
    public static final String ARG_OUTPUT_FORMAT = "--output-format";
    public static final String ARG_STREAM_JSON = "stream-json";
    public static final String ARG_VERBOSE = "--verbose";
    public static final String ARG_INCLUDE_PARTIAL = "--include-partial-messages";
    public static final String ARG_PERMISSION_MODE = "--permission-mode";
    public static final String ARG_DANGEROUS_SKIP = "--dangerously-skip-permissions";
    public static final String ARG_MODEL = "--model";
    public static final String ARG_EFFORT = "--effort";
    public static final String ARG_MCP_CONFIG = "--mcp-config";
    public static final String ARG_ADD_DIR = "--add-dir";
    public static final String ARG_RESUME = "--resume";
    public static final String ARG_NO_COLOR = "NO_COLOR";

    // ── Codex CLI 参数 ─────────────────────────────────────────────────────────

    public static final String CODEX_ARG_EXEC = "exec";
    public static final String CODEX_ARG_RESUME = "resume";
    public static final String CODEX_ARG_JSON = "--json";
    public static final String CODEX_ARG_COLOR = "--color";
    public static final String CODEX_ARG_NEVER = "never";
    public static final String CODEX_ARG_SANDBOX = "--sandbox";
    public static final String CODEX_ARG_C = "-C";
    public static final String CODEX_ARG_M = "-m";
    public static final String CODEX_ARG_IMAGE = "--image";
    public static final String CODEX_ARG_SEPARATOR = "--";
    public static final String CODEX_ARG_STDIN = "-";
    public static final String CODEX_ARG_ASK_APPROVAL = "--ask-for-approval";
    public static final String CODEX_ARG_LAST = "--last";
    public static final String CODEX_ARG_C_CONFIG = "-c";
    public static final String CODEX_ARG_I_CONFIG = "-i";

    // ── Sandbox 模式值 ─────────────────────────────────────────────────────────

    public static final String SANDBOX_READ_ONLY = "read-only";
    public static final String SANDBOX_WORKSPACE_WRITE = "workspace-write";
    public static final String SANDBOX_DANGER_FULL_ACCESS = "danger-full-access";

    public static final Set<String> VALID_SANDBOX_MODES = Set.of(
            SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE, SANDBOX_DANGER_FULL_ACCESS
    );

    // ── 权限模式值 ─────────────────────────────────────────────────────────────

    public static final String PERM_BYPASS = "bypassPermissions";
    public static final String PERM_DEFAULT = "default";
    public static final String PERM_ACCEPT_EDITS = "acceptEdits";
    public static final String PERM_PLAN = "plan";
    public static final String PERM_AUTO_EDIT = "autoEdit";

    public static final Set<String> VALID_PERMISSION_MODES = Set.of(
            PERM_DEFAULT, PERM_ACCEPT_EDITS, PERM_PLAN
    );

    // ── 环境变量名 (Anthropic / Claude) ────────────────────────────────────────

    public static final String ENV_ANTHROPIC_MODEL = "ANTHROPIC_MODEL";
    public static final String ENV_ANTHROPIC_DEFAULT_OPUS_MODEL = "ANTHROPIC_DEFAULT_OPUS_MODEL";
    public static final String ENV_ANTHROPIC_DEFAULT_SONNET_MODEL = "ANTHROPIC_DEFAULT_SONNET_MODEL";
    public static final String ENV_ANTHROPIC_SMALL_FAST_MODEL = "ANTHROPIC_SMALL_FAST_MODEL";
    public static final String ENV_ANTHROPIC_DEFAULT_HAIKU_MODEL = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
    public static final String ENV_ANTHROPIC_MODEL_CAPABILITIES = "ANTHROPIC_MODEL_CAPABILITIES";
    public static final String ENV_ANTHROPIC_DEFAULT_OPUS_MODEL_CAPS = "ANTHROPIC_DEFAULT_OPUS_MODEL_CAPABILITIES";
    public static final String ENV_ANTHROPIC_DEFAULT_SONNET_MODEL_CAPS = "ANTHROPIC_DEFAULT_SONNET_MODEL_CAPABILITIES";
    public static final String ENV_ANTHROPIC_SMALL_FAST_MODEL_CAPS = "ANTHROPIC_SMALL_FAST_MODEL_CAPABILITIES";
    public static final String ENV_ANTHROPIC_DEFAULT_HAIKU_MODEL_CAPS = "ANTHROPIC_DEFAULT_HAIKU_MODEL_CAPABILITIES";
    public static final String ENV_ANTHROPIC_API_KEY_HELPER = "ANTHROPIC_API_KEY_HELPER";

    // ── 环境变量名 (Codex / OpenAI) ────────────────────────────────────────────

    public static final String ENV_CODEX_HOME = "CODEX_HOME";
    public static final String ENV_CODEX_MODEL = "CODEX_MODEL";
    public static final String ENV_CODEX_SANDBOX = "CODEX_SANDBOX";
    public static final String ENV_CODEX_SANDBOX_MODE = "CODEX_SANDBOX_MODE";
    public static final String ENV_CODEX_SANDBOX_NETWORK_DISABLED = "CODEX_SANDBOX_NETWORK_DISABLED";
    public static final String ENV_CODEX_USE_STDIN = "CODEX_USE_STDIN";
    public static final String ENV_CODEX_APPROVAL_POLICY = "CODEX_APPROVAL_POLICY";
    public static final String ENV_CODEX_CI = "CODEX_CI";
    public static final String ENV_CLAUDE_USE_STDIN = "CLAUDE_USE_STDIN";
    public static final String ENV_OPENAI_BASE_URL = "OPENAI_BASE_URL";
    public static final String ENV_OPENAI_API_KEY = "OPENAI_API_KEY";
    public static final String ENV_OPENAI_ORG_ID = "OPENAI_ORG_ID";
    public static final String ENV_OPENAI_PROJECT_ID = "OPENAI_PROJECT_ID";
    public static final String ENV_EACASE_API_KEY = "EACASE_API_KEY";

    /** Codex 认证相关环境变量键列表。 */
    public static final List<String> CODEX_AUTH_ENV_KEYS = List.of(
            ENV_OPENAI_API_KEY, ENV_OPENAI_BASE_URL,
            ENV_OPENAI_ORG_ID, ENV_OPENAI_PROJECT_ID, ENV_EACASE_API_KEY
    );

    // ── 环境变量名 (Claude 权限 / 会话) ────────────────────────────────────────

    public static final String ENV_CLAUDE_SESSION_ID = "CLAUDE_SESSION_ID";
    public static final String ENV_CLAUDE_PERMISSION_DIR = "CLAUDE_PERMISSION_DIR";
    public static final String ENV_CLAUDE_PERMISSION_SAFETY_NET_MS = "CLAUDE_PERMISSION_SAFETY_NET_MS";
    public static final String ENV_IDEA_PROJECT_PATH = "IDEA_PROJECT_PATH";
    public static final String ENV_PROJECT_PATH = "PROJECT_PATH";

    // ── MCP 配置 ───────────────────────────────────────────────────────────────

    public static final String MCP_SERVERS_KEY = "mcpServers";

    // ── 图片相关 ───────────────────────────────────────────────────────────────

    public static final Set<String> IMAGE_EXTENSIONS = Set.of(
            ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"
    );

    // ── Prompt 模板片段 ────────────────────────────────────────────────────────

    public static final String PROMPT_OPENED_FILES = "\n\n## Opened Files Context\n\n";
    public static final String PROMPT_REFERENCED = "\n\n## Referenced Files\n\n";
    public static final String PROMPT_AGENT_ROLE = "\n\n## Agent Role and Instructions\n\n";
    public static final String PROMPT_READ_IMAGE = "Use the Read tool to inspect this image file";

    // ── 正常流式 JSON 事件前缀（用于 CliErrorFormatter 过滤） ───────────────────

    public static final List<String> NORMAL_STREAM_EVENT_PREFIXES = List.of(
            "{\"type\":\"system\"",
            "{\"type\":\"stream_event\"",
            "{\"type\":\"assistant\"",
            "{\"type\":\"user\"",
            "{\"type\":\"result\""
    );

    // ── 错误摘要关键词规则 ─────────────────────────────────────────────────────

    public static final List<String> TIMEOUT_KEYWORDS = List.of("timeout", "timed out");
    public static final List<String> AUTH_KEYWORDS = List.of("unauthorized", "authentication", "auth failed");
    public static final List<String> RATE_LIMIT_KEYWORDS = List.of("rate limit", "quota");
    public static final List<String> NETWORK_KEYWORDS = List.of("network", "connection", "dns");

    // ── Windows 系统环境变量名 ─────────────────────────────────────────────────

    public static final List<String> WINDOWS_SYSTEM_ENV_KEYS = List.of(
            "SystemRoot", "ComSpec", "PATHEXT", "WINDIR", "NUMBER_OF_PROCESSORS"
    );

    // ── 终端/区域设置环境变量名 ────────────────────────────────────────────────

    public static final List<String> TERMINAL_HINT_ENV_KEYS = List.of(
            "TERM", "TERM_PROGRAM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"
    );

    // ── 代理环境变量名 ─────────────────────────────────────────────────────────

    public static final List<String> PROXY_ENV_KEYS = List.of(
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"
    );

    // ── Windows 脚本后缀 ───────────────────────────────────────────────────────

    public static final List<String> WINDOWS_SCRIPT_SUFFIXES = List.of(".cmd", ".bat");

    // ── PowerShell 诊断行前缀 ──────────────────────────────────────────────────

    public static final List<String> POWERSHELL_DIAGNOSTIC_PREFIXES = List.of(
            "At line:", "CategoryInfo :", "FullyQualifiedErrorId :"
    );

    // ── CliAttachmentHandler 日志前缀 ──────────────────────────────────────────

    public static final String LOG_PREFIX_IMAGE_DIAG = "[ClaudeImageDiag][CliAttachmentHandler] ";

    // ── 模型家族标识 ───────────────────────────────────────────────────────────

    public static final String MODEL_PREFIX = "claude-";
    public static final String MODEL_PREFIX_ALT = "claude_";
}
