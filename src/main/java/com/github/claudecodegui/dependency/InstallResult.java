package com.github.claudecodegui.dependency;

/**
 * SDK 安装结果 DTO
 */
public class InstallResult {

    private final boolean success;
    private final String sdkId;
    private final String installedVersion;
    private final String errorMessage;
    private final String logs;

    private InstallResult(Builder builder) {
        this.success = builder.success;
        this.sdkId = builder.sdkId;
        this.installedVersion = builder.installedVersion;
        this.errorMessage = builder.errorMessage;
        this.logs = builder.logs;
    }

    public boolean isSuccess() {
        return success;
    }

    public String getSdkId() {
        return sdkId;
    }

    public String getInstalledVersion() {
        return installedVersion;
    }

    public String getErrorMessage() {
        return errorMessage;
    }

    public String getLogs() {
        return logs;
    }

    /**
     * 创建成功结果
     */
    public static InstallResult success(String sdkId, String version, String logs) {
        return new Builder()
            .success(true)
            .sdkId(sdkId)
            .installedVersion(version)
            .logs(logs)
            .build();
    }

    /**
     * 创建失败结果
     */
    public static InstallResult failure(String sdkId, String errorMessage, String logs) {
        return new Builder()
            .success(false)
            .sdkId(sdkId)
            .errorMessage(errorMessage)
            .logs(logs)
            .build();
    }

    public static class Builder {
        private boolean success;
        private String sdkId;
        private String installedVersion;
        private String errorMessage;
        private String logs;

        public Builder success(boolean success) {
            this.success = success;
            return this;
        }

        public Builder sdkId(String sdkId) {
            this.sdkId = sdkId;
            return this;
        }

        public Builder installedVersion(String installedVersion) {
            this.installedVersion = installedVersion;
            return this;
        }

        public Builder errorMessage(String errorMessage) {
            this.errorMessage = errorMessage;
            return this;
        }

        public Builder logs(String logs) {
            this.logs = logs;
            return this;
        }

        public InstallResult build() {
            return new InstallResult(this);
        }
    }
}
