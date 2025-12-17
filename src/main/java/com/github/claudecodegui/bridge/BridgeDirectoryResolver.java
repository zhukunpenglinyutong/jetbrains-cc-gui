package com.github.claudecodegui.bridge;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.util.io.FileUtil;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import com.github.claudecodegui.util.PlatformUtils;

/**
 * Bridge 目录解析器
 * 负责查找和管理 ai-bridge 目录（统一的 Claude 和 Codex SDK 桥接）
 */
public class BridgeDirectoryResolver {

    private static final String SDK_DIR_NAME = "ai-bridge";
    private static final String NODE_SCRIPT = "channel-manager.js";
    private static final String SDK_ARCHIVE_NAME = "ai-bridge.zip";
    private static final String BRIDGE_VERSION_FILE = ".bridge-version";
    private static final String BRIDGE_PATH_PROPERTY = "claude.bridge.path";
    private static final String BRIDGE_PATH_ENV = "CLAUDE_BRIDGE_PATH";
    private static final String PLUGIN_ID = "com.github.idea-claude-code-gui";
    private static final String PLUGIN_DIR_NAME = "idea-claude-code-gui";

    private File cachedSdkDir = null;
    private final Object bridgeExtractionLock = new Object();

    /**
     * 查找 claude-bridge 目录
     */
    public File findSdkDir() {
        if (cachedSdkDir != null && cachedSdkDir.exists()) {
            return cachedSdkDir;
        }

        File configuredDir = resolveConfiguredBridgeDir();
        if (configuredDir != null) {
            cachedSdkDir = configuredDir;
            return cachedSdkDir;
        }

        File embeddedDir = ensureEmbeddedBridgeExtracted();
        if (embeddedDir != null) {
            cachedSdkDir = embeddedDir;
            return cachedSdkDir;
        }

        System.out.println("正在查找 ai-bridge 目录...");

        // 可能的位置列表
        List<File> possibleDirs = new ArrayList<>();

        // 1. 当前工作目录
        File currentDir = new File(System.getProperty("user.dir"));
        addCandidate(possibleDirs, new File(currentDir, SDK_DIR_NAME));

        // 2. 项目根目录（假设当前目录可能在子目录中）
        File parent = currentDir.getParentFile();
        while (parent != null && parent.exists()) {
            boolean hasIdeaDir = new File(parent, ".idea").exists();
            boolean hasBridgeDir = new File(parent, SDK_DIR_NAME).exists();
            if (hasIdeaDir || hasBridgeDir) {
                addCandidate(possibleDirs, new File(parent, SDK_DIR_NAME));
                if (hasIdeaDir) {
                    break;
                }
            }
            if (isRootDirectory(parent)) {
                break;
            }
            parent = parent.getParentFile();
        }

        // 3. 插件目录及 sandbox
        addPluginCandidates(possibleDirs);

        // 4. 基于类路径推断
        addClasspathCandidates(possibleDirs);

        // 查找第一个存在的目录
        for (File dir : possibleDirs) {
            if (isValidBridgeDir(dir)) {
                cachedSdkDir = dir;
                System.out.println("✓ 找到 ai-bridge 目录: " + cachedSdkDir.getAbsolutePath());
                return cachedSdkDir;
            }
        }

        // 如果都找不到，打印调试信息
        System.err.println("⚠️ 无法找到 ai-bridge 目录，已尝试以下位置：");
        for (File dir : possibleDirs) {
            System.err.println("  - " + dir.getAbsolutePath() + " (存在: " + dir.exists() + ")");
        }

        // 返回默认值
        cachedSdkDir = new File(currentDir, SDK_DIR_NAME);
        System.err.println("  使用默认路径: " + cachedSdkDir.getAbsolutePath());
        return cachedSdkDir;
    }

    /**
     * 解析配置的 Bridge 目录
     */
    private File resolveConfiguredBridgeDir() {
        File fromProperty = tryResolveConfiguredPath(
            System.getProperty(BRIDGE_PATH_PROPERTY),
            "系统属性 " + BRIDGE_PATH_PROPERTY
        );
        if (fromProperty != null) {
            return fromProperty;
        }
        return tryResolveConfiguredPath(
            System.getenv(BRIDGE_PATH_ENV),
            "环境变量 " + BRIDGE_PATH_ENV
        );
    }

    private File tryResolveConfiguredPath(String path, String source) {
        if (path == null || path.trim().isEmpty()) {
            return null;
        }
        File dir = new File(path.trim());
        if (isValidBridgeDir(dir)) {
            System.out.println("✓ 使用 " + source + ": " + dir.getAbsolutePath());
            return dir;
        }
        System.err.println("⚠️ " + source + " 指向无效目录: " + dir.getAbsolutePath());
        return null;
    }

    private void addPluginCandidates(List<File> possibleDirs) {
        try {
            PluginId pluginId = PluginId.getId(PLUGIN_ID);
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor != null) {
                File pluginDir = descriptor.getPluginPath().toFile();
                addCandidate(possibleDirs, new File(pluginDir, SDK_DIR_NAME));
            }
        } catch (Throwable t) {
            System.out.println("  无法从插件描述符推断: " + t.getMessage());
        }

        try {
            String pluginsRoot = PathManager.getPluginsPath();
            if (!pluginsRoot.isEmpty()) {
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_DIR_NAME, SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_ID, SDK_DIR_NAME).toFile());
            }

            // 使用系统路径下的 plugins 目录代替已废弃的 getPluginTempPath()
            String systemPath = PathManager.getSystemPath();
            if (!systemPath.isEmpty()) {
                Path sandboxPath = Paths.get(systemPath, "plugins");
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_DIR_NAME).resolve(SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_ID).resolve(SDK_DIR_NAME).toFile());
            }
        } catch (Throwable t) {
            System.out.println("  无法从插件路径推断: " + t.getMessage());
        }
    }

    private void addClasspathCandidates(List<File> possibleDirs) {
        try {
            CodeSource codeSource = BridgeDirectoryResolver.class.getProtectionDomain().getCodeSource();
            if (codeSource == null || codeSource.getLocation() == null) {
                System.out.println("  无法从类路径推断: CodeSource 不可用");
                return;
            }
            File location = new File(codeSource.getLocation().toURI());
            File classDir = location.getParentFile();
            while (classDir != null && classDir.exists()) {
                addCandidate(possibleDirs, new File(classDir, SDK_DIR_NAME));
                String name = classDir.getName();
                if (PLUGIN_DIR_NAME.equals(name) || PLUGIN_ID.equals(name)) {
                    break;
                }
                if (isRootDirectory(classDir)) {
                    break;
                }
                classDir = classDir.getParentFile();
            }
        } catch (Exception e) {
            System.out.println("  无法从类路径推断: " + e.getMessage());
        }
    }

    /**
     * 验证目录是否为有效的 bridge 目录
     */
    public boolean isValidBridgeDir(File dir) {
        if (dir == null) {
            return false;
        }
        if (!dir.exists() || !dir.isDirectory()) {
            return false;
        }
        File scriptFile = new File(dir, NODE_SCRIPT);
        return scriptFile.exists();
    }

    private void addCandidate(List<File> possibleDirs, File dir) {
        if (dir == null) {
            return;
        }
        String candidatePath = dir.getAbsolutePath();
        for (File existing : possibleDirs) {
            if (existing.getAbsolutePath().equals(candidatePath)) {
                return;
            }
        }
        possibleDirs.add(dir);
    }

    private boolean isRootDirectory(File dir) {
        return dir.getParentFile() == null;
    }

    private File ensureEmbeddedBridgeExtracted() {
        try {
            System.out.println("[BridgeResolver] 尝试查找内嵌的 ai-bridge.zip...");

            PluginId pluginId = PluginId.getId(PLUGIN_ID);
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor == null) {
                System.out.println("[BridgeResolver] 无法通过 PluginId 获取插件描述符: " + PLUGIN_ID);

                // 尝试通过遍历所有插件来查找
                for (IdeaPluginDescriptor plugin : PluginManagerCore.getPlugins()) {
                    String id = plugin.getPluginId().getIdString();
                    String name = plugin.getName();
                    // 匹配插件 ID 或名称
                    if (id.contains("claude") || id.contains("Claude") ||
                        (name != null && (name.contains("Claude") || name.contains("claude")))) {
                        System.out.println("[BridgeResolver] 找到候选插件: id=" + id + ", name=" + name + ", path=" + plugin.getPluginPath());
                        File candidateDir = plugin.getPluginPath().toFile();
                        File candidateArchive = new File(candidateDir, SDK_ARCHIVE_NAME);
                        if (candidateArchive.exists()) {
                            System.out.println("[BridgeResolver] 在候选插件中找到 ai-bridge.zip: " + candidateArchive.getAbsolutePath());
                            descriptor = plugin;
                            break;
                        }
                    }
                }

                if (descriptor == null) {
                    System.out.println("[BridgeResolver] 未能通过任何方式找到插件描述符");
                    return null;
                }
            }

            File pluginDir = descriptor.getPluginPath().toFile();
            System.out.println("[BridgeResolver] 插件目录: " + pluginDir.getAbsolutePath());

            File archiveFile = new File(pluginDir, SDK_ARCHIVE_NAME);
            System.out.println("[BridgeResolver] 查找压缩包: " + archiveFile.getAbsolutePath() + " (存在: " + archiveFile.exists() + ")");

            if (!archiveFile.exists()) {
                // 尝试在 lib 目录下查找
                File libDir = new File(pluginDir, "lib");
                if (libDir.exists()) {
                    System.out.println("[BridgeResolver] 检查 lib 目录: " + libDir.getAbsolutePath());
                    File[] files = libDir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            System.out.println("[BridgeResolver]   - " + f.getName());
                        }
                    }
                }

                // 如果在插件目录或 lib 下找不到，尝试查找常见的 sandbox 顶级 plugins 目录和 system/config 下的 plugins
                List<File> fallbackCandidates = new ArrayList<>();
                try {
                    // 向上查找祖先，寻找可能的 idea-sandbox 根目录或包含顶级 plugins 的目录
                    File ancestor = pluginDir;
                    int climbs = 0;
                    while (climbs < 6) {
                        File parent = ancestor.getParentFile();
                        if (parent == null) break;

                        File maybeTopPlugins = new File(parent, "plugins");
                        if (maybeTopPlugins.exists() && maybeTopPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeTopPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeTopPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }

                        // system/config siblings under this parent
                        File maybeSystemPlugins = new File(parent, "system/plugins");
                        File maybeConfigPlugins = new File(parent, "config/plugins");
                        if (maybeSystemPlugins.exists() && maybeSystemPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeSystemPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeSystemPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }
                        if (maybeConfigPlugins.exists() && maybeConfigPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeConfigPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeConfigPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }

                        ancestor = parent;
                        climbs++;
                    }
                } catch (Throwable ignore) {
                    // ignore fallback discovery errors
                }

                // 打印并尝试这些候选路径
                for (File f : fallbackCandidates) {
                    System.out.println("[BridgeResolver] 尝试候选路径: " + f.getAbsolutePath() + " (存在: " + f.exists() + ")");
                    if (f.exists()) {
                        archiveFile = f;
                        break;
                    }
                }

                if (!archiveFile.exists()) {
                    return null;
                }

            }

            File extractedDir = new File(pluginDir, SDK_DIR_NAME);
            String signature = descriptor.getVersion() + ":" + archiveFile.lastModified();
            File versionFile = new File(extractedDir, BRIDGE_VERSION_FILE);

            if (isValidBridgeDir(extractedDir) && bridgeSignatureMatches(versionFile, signature)) {
                return extractedDir;
            }

            synchronized (bridgeExtractionLock) {
                if (isValidBridgeDir(extractedDir) && bridgeSignatureMatches(versionFile, signature)) {
                    return extractedDir;
                }

                System.out.println("未检测到已解压的 ai-bridge，开始解压: " + archiveFile.getAbsolutePath());
                deleteDirectory(extractedDir);
                unzipArchive(archiveFile, extractedDir);
                Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);
            }

            if (isValidBridgeDir(extractedDir)) {
                System.out.println("✓ ai-bridge 解压完成: " + extractedDir.getAbsolutePath());
                return extractedDir;
            }

            System.err.println("⚠️ ai-bridge 解压后结构无效: " + extractedDir.getAbsolutePath());
        } catch (Exception e) {
            System.err.println("⚠️ 自动解压 ai-bridge 失败: " + e.getMessage());
        }
        return null;
    }

    private boolean bridgeSignatureMatches(File versionFile, String expectedSignature) {
        if (versionFile == null || !versionFile.exists()) {
            return false;
        }
        try {
            String content = Files.readString(versionFile.toPath(), StandardCharsets.UTF_8).trim();
            return expectedSignature.equals(content);
        } catch (IOException e) {
            return false;
        }
    }

    private void deleteDirectory(File dir) {
        if (dir == null || !dir.exists()) {
            return;
        }
        // 使用带重试机制的目录删除，处理 Windows 文件锁定问题
        if (!PlatformUtils.deleteDirectoryWithRetry(dir, 3)) {
            // 如果重试失败，回退到 IntelliJ 的 FileUtil
            if (!FileUtil.delete(dir)) {
                System.err.println("⚠️ 无法删除目录: " + dir.getAbsolutePath());
            }
        }
    }

    private void unzipArchive(File archiveFile, File targetDir) throws IOException {
        Files.createDirectories(targetDir.toPath());
        Path targetPath = targetDir.toPath();
        byte[] buffer = new byte[8192];

        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path resolvedPath = targetPath.resolve(entry.getName()).normalize();
                if (!resolvedPath.startsWith(targetPath)) {
                    throw new IOException("检测到不安全的 Zip 条目: " + entry.getName());
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(resolvedPath);
                } else {
                    Files.createDirectories(resolvedPath.getParent());
                    try (FileOutputStream fos = new FileOutputStream(resolvedPath.toFile())) {
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                }

                zis.closeEntry();
            }
        }
    }

    /**
     * 手动设置 claude-bridge 目录路径.
     */
    public void setSdkDir(String path) {
        this.cachedSdkDir = new File(path);
    }

    /**
     * 获取当前使用的 claude-bridge 目录.
     */
    public File getSdkDir() {
        if (this.cachedSdkDir == null) {
            return this.findSdkDir();
        }
        return this.cachedSdkDir;
    }

    /**
     * 清除缓存.
     */
    public void clearCache() {
        this.cachedSdkDir = null;
    }
}

