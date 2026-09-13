package com.github.claudecodegui.cli;

/**
 * Detection result for a single CLI tool.
 */
public final class CliToolStatus {

    private final String id;
    private final String name;
    private final String binaryName;
    private final boolean installed;
    private final String version;
    private final String path;
    private final String error;

    private CliToolStatus(
            String id,
            String name,
            String binaryName,
            boolean installed,
            String version,
            String path,
            String error
    ) {
        this.id = id;
        this.name = name;
        this.binaryName = binaryName;
        this.installed = installed;
        this.version = version;
        this.path = path;
        this.error = error;
    }

    public static CliToolStatus installed(CliToolId tool, String version, String path) {
        return new CliToolStatus(
                tool.getId(),
                tool.getDisplayName(),
                tool.getBinaryName(),
                true,
                version,
                path,
                null
        );
    }

    public static CliToolStatus notInstalled(CliToolId tool) {
        return new CliToolStatus(
                tool.getId(),
                tool.getDisplayName(),
                tool.getBinaryName(),
                false,
                null,
                null,
                null
        );
    }

    public static CliToolStatus error(CliToolId tool, String error) {
        return new CliToolStatus(
                tool.getId(),
                tool.getDisplayName(),
                tool.getBinaryName(),
                false,
                null,
                null,
                error
        );
    }

    public String getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getBinaryName() {
        return binaryName;
    }

    public boolean isInstalled() {
        return installed;
    }

    public String getVersion() {
        return version;
    }

    public String getPath() {
        return path;
    }

    public String getError() {
        return error;
    }
}
