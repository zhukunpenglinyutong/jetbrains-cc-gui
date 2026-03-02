package com.github.claudecodegui.util;

import com.github.claudecodegui.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import javazoom.jl.decoder.JavaLayerException;
import javazoom.jl.player.Player;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.Clip;
import javax.sound.sampled.LineEvent;
import javax.sound.sampled.UnsupportedAudioFileException;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.URI;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 声音通知服务
 * 负责在任务完成时播放提示音
 */
public class SoundNotificationService {

    private static final Logger LOG = Logger.getInstance(SoundNotificationService.class);

    /**
     * Built-in sound resources: soundId -> resource path.
     * Insertion order preserved for UI display.
     */
    public static final Map<String, String> SOUND_RESOURCES;

    static {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("default", "/sounds/success.wav");
        map.put("chime", "/sounds/chime.wav");
        map.put("bell", "/sounds/bell.wav");
        map.put("ding", "/sounds/ding.wav");
        map.put("success", "/sounds/task-complete.wav");
        SOUND_RESOURCES = Collections.unmodifiableMap(map);
    }

    // 单例模式
    private static volatile SoundNotificationService instance;

    private SoundNotificationService() {
    }

    public static SoundNotificationService getInstance() {
        if (instance == null) {
            synchronized (SoundNotificationService.class) {
                if (instance == null) {
                    instance = new SoundNotificationService();
                }
            }
        }
        return instance;
    }

    /**
     * Play task completion notification sound based on user settings.
     */
    public void playTaskCompleteSound() {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                CodemossSettingsService settings = new CodemossSettingsService();

                if (!settings.getSoundNotificationEnabled()) {
                    LOG.debug("[SoundNotification] Sound notification is disabled");
                    return;
                }

                String selectedSound = settings.getSelectedSound();
                playBySelection(selectedSound, settings.getCustomSoundPath());
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to play notification sound: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Play sound by selection: built-in soundId or custom file path.
     */
    private void playBySelection(String soundId, String customPath) throws Exception {
        if ("custom".equals(soundId)) {
            String normalizedCustomPath = normalizeSoundPath(customPath);
            if (normalizedCustomPath != null && !normalizedCustomPath.isEmpty()) {
                LOG.debug("[SoundNotification] Playing custom sound: " + normalizedCustomPath);
                playFromFile(normalizedCustomPath);
            } else {
                LOG.debug("[SoundNotification] Custom selected but no path, falling back to default");
                playFromResource(SOUND_RESOURCES.get("default"));
            }
        } else {
            String resourcePath = SOUND_RESOURCES.getOrDefault(soundId, SOUND_RESOURCES.get("default"));
            LOG.debug("[SoundNotification] Playing built-in sound: " + soundId);
            playFromResource(resourcePath);
        }
    }

    /**
     * Test play a sound (for settings preview).
     *
     * @param soundId    sound ID ("default", "chime", "bell", "ding", "success", "custom")
     * @param customPath custom file path (only used when soundId is "custom")
     */
    public void testPlaySound(String soundId, String customPath) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                playBySelection(
                        soundId != null ? soundId : "default",
                        customPath
                );
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to play test sound: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 从资源文件播放音频
     */
    private void playFromResource(String resourcePath) throws Exception {
        try (InputStream rawStream = getClass().getResourceAsStream(resourcePath)) {
            if (rawStream == null) {
                LOG.warn("[SoundNotification] Sound resource not found: " + resourcePath);
                return;
            }

            // 使用 BufferedInputStream 包装，因为 AudioSystem 需要 mark/reset 支持
            try (BufferedInputStream bufferedStream = new BufferedInputStream(rawStream);
                    AudioInputStream audioIn = AudioSystem.getAudioInputStream(bufferedStream)) {
                playAudioStream(audioIn);
            }
        }
    }

    /**
     * Normalize user provided sound path (supports file:// URI).
     */
    private String normalizeSoundPath(String filePath) {
        if (filePath == null) {
            return null;
        }

        String normalized = filePath.trim();
        if (normalized.isEmpty()) {
            return normalized;
        }

        // Remove wrapping quotes to avoid lookup failures on Windows.
        if (normalized.length() >= 2 && normalized.startsWith("\"") && normalized.endsWith("\"")) {
            normalized = normalized.substring(1, normalized.length() - 1);
        }

        if (normalized.startsWith("file://")) {
            try {
                normalized = new File(new URI(normalized)).getPath();
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to parse file URI: " + normalized + " - " + e.getMessage());
            }
        }

        return normalized;
    }

    private boolean isWindows() {
        return System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win");
    }

    private boolean pathEquals(String a, String b) {
        if (isWindows()) {
            return a.equalsIgnoreCase(b);
        }
        return a.equals(b);
    }

    private boolean pathStartsWith(String path, String prefix) {
        if (isWindows()) {
            return path.toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT));
        }
        return path.startsWith(prefix);
    }

    /**
     * Check if the file path is safe (no path traversal, must be under user home directory).
     */
    private boolean isPathSafe(String filePath) {
        try {
            String normalizedPath = normalizeSoundPath(filePath);
            if (normalizedPath == null || normalizedPath.isEmpty()) {
                return false;
            }
            if (normalizedPath.contains("..")) {
                return false;
            }

            File file = new File(normalizedPath);
            String canonical = file.getCanonicalPath();
            String userHome = new File(PlatformUtils.getHomeDirectory()).getCanonicalPath();

            // Only allow files under user home directory to prevent arbitrary file access
            return pathStartsWith(canonical, userHome);
        } catch (java.io.IOException e) {
            return false;
        }
    }

    /**
     * 从文件播放音频
     */
    private void playFromFile(String rawPath) throws Exception {
        String normalizedPath = normalizeSoundPath(rawPath);
        if (normalizedPath == null || normalizedPath.isEmpty()) {
            LOG.warn("[SoundNotification] Custom sound path is empty");
            return;
        }

        if (!isPathSafe(normalizedPath)) {
            LOG.warn("[SoundNotification] Blocked unsafe file path: " + normalizedPath);
            return;
        }

        File file = new File(normalizedPath);
        if (!file.exists() || !file.canRead()) {
            LOG.warn("[SoundNotification] Sound file not found or not readable: " + file.getAbsolutePath());
            return;
        }

        String fileName = file.getName().toLowerCase(Locale.ROOT);

        // MP3 格式使用 JLayer 在后台线程解码播放
        if (fileName.endsWith(".mp3")) {
            playMp3(file);
            return;
        }

        // WAV 和 AIFF 格式使用 Java 标准库播放
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            playAudioStream(audioIn);
        }
    }

    /**
     * Max playback time for MP3 files (seconds).
     * Prevents a corrupted/oversized file from blocking the pooled thread indefinitely.
     */
    private static final int MP3_PLAYBACK_TIMEOUT_SECONDS = 30;

    /**
     * 使用 JLayer 播放 MP3（后台线程调用，阻塞直到播放结束或超时）。
     */
    private void playMp3(File file) throws Exception {
        try (BufferedInputStream bufferedStream = new BufferedInputStream(new FileInputStream(file))) {
            Player player = new Player(bufferedStream);
            CountDownLatch latch = new CountDownLatch(1);

            Thread playThread = new Thread(() -> {
                try {
                    player.play();
                } catch (JavaLayerException e) {
                    LOG.warn("[SoundNotification] MP3 playback error: " + e.getMessage());
                } finally {
                    latch.countDown();
                }
            }, "SoundNotification-MP3");
            playThread.setDaemon(true);
            playThread.start();

            if (!latch.await(MP3_PLAYBACK_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                LOG.warn("[SoundNotification] MP3 playback timed out after " + MP3_PLAYBACK_TIMEOUT_SECONDS + "s");
                player.close();
                playThread.interrupt();
            }
        } catch (JavaLayerException e) {
            throw new Exception("Failed to decode MP3: " + e.getMessage(), e);
        }
    }

    /**
     * Play an audio stream and block until playback completes.
     */
    private void playAudioStream(AudioInputStream audioIn) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        Clip clip = AudioSystem.getClip();
        clip.addLineListener(event -> {
            if (event.getType() == LineEvent.Type.STOP) {
                latch.countDown();
            }
        });
        clip.open(audioIn);
        clip.start();

        // Wait for playback to complete (max 10 seconds)
        latch.await(10, TimeUnit.SECONDS);

        if (clip.isOpen()) {
            clip.close();
        }
    }

    /**
     * 验证音频文件是否可用
     *
     * @param filePath 文件路径
     * @return 验证结果，包含成功状态和错误信息
     */
    public ValidationResult validateSoundFile(String filePath) {
        String normalizedPath = normalizeSoundPath(filePath);
        if (normalizedPath == null || normalizedPath.isEmpty()) {
            return new ValidationResult(true, null); // 空路径表示使用默认声音
        }

        if (!isPathSafe(normalizedPath)) {
            return new ValidationResult(false, "Invalid file path");
        }

        File file = new File(normalizedPath);

        if (!file.exists()) {
            return new ValidationResult(false, "File not found");
        }

        if (!file.canRead()) {
            return new ValidationResult(false, "File is not readable");
        }

        String lowerPath = normalizedPath.toLowerCase(Locale.ROOT);
        if (!lowerPath.endsWith(".wav") && !lowerPath.endsWith(".mp3") && !lowerPath.endsWith(".aiff")) {
            return new ValidationResult(false, "Only WAV, MP3, AIFF formats are supported");
        }

        // MP3 使用 JLayer 播放，跳过 AudioSystem 格式校验
        if (lowerPath.endsWith(".mp3")) {
            return new ValidationResult(true, null);
        }

        // For WAV and AIFF, try loading to validate format
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            return new ValidationResult(true, null);
        } catch (UnsupportedAudioFileException e) {
            return new ValidationResult(false, "Unsupported audio format");
        } catch (Exception e) {
            return new ValidationResult(false, "Cannot read audio file: " + e.getMessage());
        }
    }

    /**
     * 验证结果
     */
    public record ValidationResult(boolean valid, String errorMessage) {
    }
}
