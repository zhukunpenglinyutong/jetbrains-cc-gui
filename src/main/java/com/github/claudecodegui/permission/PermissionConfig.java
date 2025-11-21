package com.github.claudecodegui.permission;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * 权限配置类
 * 定义需要权限控制的工具和默认配置
 */
public class PermissionConfig {

    /**
     * 需要权限控制的工具列表
     */
    public static final Set<String> CONTROLLED_TOOLS = new HashSet<>(Arrays.asList(
        // 文件操作
        "Write",           // 写入文件
        "Edit",            // 编辑文件
        "Delete",          // 删除文件
        "CreateDirectory", // 创建目录
        "MoveFile",        // 移动文件
        "CopyFile",        // 复制文件
        "Rename",          // 重命名文件

        // 系统操作
        "Bash",            // 执行Shell命令
        "ExecuteCommand",  // 执行系统命令
        "RunCode",         // 运行代码
        "SystemCommand",   // 系统命令

        // 包管理
        "InstallPackage",  // 安装软件包
        "UninstallPackage",// 卸载软件包
        "UpdatePackage",   // 更新软件包

        // 网络操作
        "HttpRequest",     // HTTP请求
        "Download",        // 下载文件
        "Upload",          // 上传文件

        // Git操作
        "GitCommit",       // Git提交
        "GitPush",         // Git推送
        "GitPull",         // Git拉取
        "GitMerge",        // Git合并
        "GitCheckout",     // Git切换分支

        // 数据库操作
        "DatabaseQuery",   // 数据库查询
        "DatabaseUpdate",  // 数据库更新
        "DatabaseDelete"   // 数据库删除
    ));

    /**
     * 高风险工具 - 总是需要确认
     */
    public static final Set<String> HIGH_RISK_TOOLS = new HashSet<>(Arrays.asList(
        "Delete",
        "DatabaseDelete",
        "GitPush",
        "SystemCommand",
        "UninstallPackage"
    ));

    /**
     * 默认允许的安全工具
     */
    public static final Set<String> SAFE_TOOLS = new HashSet<>(Arrays.asList(
        "Read",            // 读取文件
        "List",            // 列出文件
        "Search",          // 搜索
        "Grep",            // 文本搜索
        "Find"             // 查找文件
    ));

    /**
     * 判断工具是否需要权限控制
     */
    public static boolean requiresPermission(String toolName) {
        return CONTROLLED_TOOLS.contains(toolName);
    }

    /**
     * 判断工具是否为高风险
     */
    public static boolean isHighRisk(String toolName) {
        return HIGH_RISK_TOOLS.contains(toolName);
    }

    /**
     * 判断工具是否安全
     */
    public static boolean isSafe(String toolName) {
        return SAFE_TOOLS.contains(toolName);
    }

    /**
     * 获取工具的风险等级描述
     */
    public static String getRiskLevel(String toolName) {
        if (isHighRisk(toolName)) {
            return "高风险";
        } else if (requiresPermission(toolName)) {
            return "需要权限";
        } else if (isSafe(toolName)) {
            return "安全";
        } else {
            return "未知";
        }
    }

    /**
     * 默认权限配置
     */
    public static class DefaultSettings {
        // 是否启用权限系统
        public static boolean ENABLED = true;

        // 是否对高风险操作总是询问
        public static boolean ALWAYS_ASK_HIGH_RISK = true;

        // 权限记忆超时时间（毫秒）
        public static long MEMORY_TIMEOUT = 3600000; // 1小时

        // 最大记忆条目数
        public static int MAX_MEMORY_ENTRIES = 100;

        // 是否记录权限日志
        public static boolean LOG_PERMISSIONS = true;

        // 是否在开发模式下跳过权限检查
        public static boolean SKIP_IN_DEV_MODE = false;
    }
}