package com.github.claudecodegui.permission;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Permission configuration class.
 * Defines tools that require permission control and default settings.
 */
public class PermissionConfig {

    /**
     * List of tools that require permission control.
     */
    public static final Set<String> CONTROLLED_TOOLS = new HashSet<>(Arrays.asList(
        // File operations
        "Write",           // Write file
        "Edit",            // Edit file
        "Delete",          // Delete file
        "CreateDirectory", // Create directory
        "MoveFile",        // Move file
        "CopyFile",        // Copy file
        "Rename",          // Rename file

        // System operations
        "Bash",            // Execute shell command
        "ExecuteCommand",  // Execute system command
        "RunCode",         // Run code
        "SystemCommand",   // System command

        // Package management
        "InstallPackage",  // Install package
        "UninstallPackage",// Uninstall package
        "UpdatePackage",   // Update package

        // Network operations
        "HttpRequest",     // HTTP request
        "Download",        // Download file
        "Upload",          // Upload file

        // Git operations
        "GitCommit",       // Git commit
        "GitPush",         // Git push
        "GitPull",         // Git pull
        "GitMerge",        // Git merge
        "GitCheckout",     // Git checkout branch

        // Database operations
        "DatabaseQuery",   // Database query
        "DatabaseUpdate",  // Database update
        "DatabaseDelete"   // Database delete
    ));

    /**
     * High-risk tools - always require confirmation.
     */
    public static final Set<String> HIGH_RISK_TOOLS = new HashSet<>(Arrays.asList(
        "Delete",
        "DatabaseDelete",
        "GitPush",
        "SystemCommand",
        "UninstallPackage"
    ));

    /**
     * Safe tools that are allowed by default.
     */
    public static final Set<String> SAFE_TOOLS = new HashSet<>(Arrays.asList(
        "Read",            // Read file
        "List",            // List files
        "Search",          // Search
        "Grep",            // Text search
        "Find"             // Find files
    ));

    /**
     * Check if a tool requires permission control.
     */
    public static boolean requiresPermission(String toolName) {
        return CONTROLLED_TOOLS.contains(toolName);
    }

    /**
     * Check if a tool is high-risk.
     */
    public static boolean isHighRisk(String toolName) {
        return HIGH_RISK_TOOLS.contains(toolName);
    }

    /**
     * Check if a tool is safe.
     */
    public static boolean isSafe(String toolName) {
        return SAFE_TOOLS.contains(toolName);
    }

    /**
     * Get the risk level description for a tool.
     */
    public static String getRiskLevel(String toolName) {
        if (isHighRisk(toolName)) {
            return "High risk";
        } else if (requiresPermission(toolName)) {
            return "Requires permission";
        } else if (isSafe(toolName)) {
            return "Safe";
        } else {
            return "Unknown";
        }
    }

    /**
     * Default permission settings.
     */
    public static class DefaultSettings {
        // Whether the permission system is enabled
        public static boolean ENABLED = true;

        // Whether to always prompt for high-risk operations
        public static boolean ALWAYS_ASK_HIGH_RISK = true;

        // Permission memory timeout in milliseconds
        public static long MEMORY_TIMEOUT = 3600000; // 1 hour

        // Maximum number of memory entries
        public static int MAX_MEMORY_ENTRIES = 100;

        // Whether to log permission events
        public static boolean LOG_PERMISSIONS = true;

        // Whether to skip permission checks in development mode
        public static boolean SKIP_IN_DEV_MODE = false;
    }
}