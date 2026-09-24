package com.github.claudecodegui.startup;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.google.gson.Gson;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;

import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.Toolkit;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import javax.imageio.ImageIO;

import org.cef.CefClient;
import org.cef.browser.CefBrowser;
import org.cef.handler.CefKeyboardHandlerAdapter;
import org.cef.misc.BoolRef;

/**
 * macOS 27 CEF remote quirk: Cmd+V keydown never reaches onPreKeyEvent as
 * KEYEVENT_RAWKEYDOWN; only an orphan KEYEVENT_KEYUP (wkc=86) arrives.
 * Strategy: on KEYUP for V, if no matching RAWKEYDOWN for V was seen within
 * 800ms, treat it as an intercepted Cmd+V and paste clipboard image.
 */
public class CefPasteHook extends CefKeyboardHandlerAdapter {

    private static final Logger LOG = Logger.getInstance(CefPasteHook.class);
    private static final Gson GSON = new Gson();
    private static final int VK_V = 0x56;
    private static final long ORPHAN_WINDOW_MS = 800;
    private static final long PASTE_DEBOUNCE_MS = 500;

    private volatile long lastVRawKeyDown = 0;
    private volatile long lastPasteTrigger = 0;
    private volatile boolean sawVRawKeyDown = false;

    private final ClaudeChatWindow myWindow;

    CefPasteHook(ClaudeChatWindow window) {
        this.myWindow = window;
    }

    public static void install(CefClient client, ClaudeChatWindow window) {
        try {
            if (client == null) {
                LOG.warn("[paste-fix][CEF] client null");
                return;
            }
            client.addKeyboardHandler(new CefPasteHook(window));
            LOG.info("[paste-fix][CEF] CefPasteHook installed on client " + System.identityHashCode(client));
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] install failed", t);
        }
    }

    @Override
    public boolean onPreKeyEvent(CefBrowser browser, org.cef.handler.CefKeyboardHandler.CefKeyEvent event, BoolRef isKeyboardShortcut) {
        try {
            if (event.windows_key_code != VK_V) {
                return false;
            }
            long now = System.currentTimeMillis();
            if (event.type == org.cef.handler.CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_RAWKEYDOWN) {
                sawVRawKeyDown = true;
                lastVRawKeyDown = now;
                LOG.info("[paste-fix][CEF] V RAWKEYDOWN seen (normal typing)");
                return false;
            }
            if (event.type != org.cef.handler.CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_KEYUP) {
                return false;
            }

            // Orphan KEYUP: no RAWKEYDOWN recently => Cmd+V whose keydown was swallowed
            boolean orphan = !(sawVRawKeyDown && (now - lastVRawKeyDown) < ORPHAN_WINDOW_MS);
            sawVRawKeyDown = false; // consume
            LOG.info("[paste-fix][CEF] V KEYUP, orphan=" + orphan);
            if (!orphan) {
                return false;
            }

            if (now - lastPasteTrigger < PASTE_DEBOUNCE_MS) {
                return false;
            }
            lastPasteTrigger = now;
            LOG.info("[paste-fix][CEF] orphan Cmd+V detected, pasting image");

            ClaudeChatWindow window = myWindow != null ? myWindow : findChatWindow();
            if (window == null) {
                LOG.info("[paste-fix][CEF] no chat window");
                return false;
            }
            ApplicationManager.getApplication().invokeLater(() -> handlePaste(window));
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] hook error", t);
        }
        return false;
    }

    private void handlePaste(ClaudeChatWindow window) {
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            if (!clipboard.isDataFlavorAvailable(DataFlavor.imageFlavor)) {
                LOG.info("[paste-fix][CEF] no image in clipboard");
                return;
            }
            Object imageData = clipboard.getData(DataFlavor.imageFlavor);
            if (imageData == null) {
                return;
            }
            LOG.info("[paste-fix][CEF] image class=" + imageData.getClass().getName());

            BufferedImage buffered;
            if (imageData instanceof BufferedImage) {
                buffered = (BufferedImage) imageData;
            } else if (imageData instanceof Image) {
                Image img = (Image) imageData;
                int w = img.getWidth(null);
                int h = img.getHeight(null);
                if (w <= 0 || h <= 0) {
                    return;
                }
                buffered = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
                Graphics2D g = buffered.createGraphics();
                g.drawImage(img, 0, 0, null);
                g.dispose();
            } else {
                return;
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            ImageIO.write(buffered, "png", baos);
            byte[] bytes = baos.toByteArray();
            baos.close();
            if (bytes.length == 0) {
                return;
            }
            String base64 = Base64.getEncoder().encodeToString(bytes);
            String js = "(function(){  window.dispatchEvent(new CustomEvent('java-paste-image',{detail:{base64:" + GSON.toJson(base64) + ",mediaType:'image/png'}}));})()";
            window.executeJavaScriptCode(js);
            LOG.info("[paste-fix][CEF] dispatched java-paste-image, len=" + base64.length());
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] handlePaste error", t);
        }
    }

    private ClaudeChatWindow findChatWindow() {
        try {
            Project[] open = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects();
            for (Project p : open) {
                if (p.isDisposed()) {
                    continue;
                }
                ToolWindow tw = ToolWindowManager.getInstance(p).getToolWindow("CCG");
                if (tw == null) {
                    continue;
                }
                if (tw.getContentManager() != null && tw.getContentManager().getSelectedContent() != null) {
                    ClaudeChatWindow w = ClaudeSDKToolWindow.getChatWindowForContent(tw.getContentManager().getSelectedContent());
                    if (w != null) {
                        return w;
                    }
                }
                ClaudeChatWindow w2 = ClaudeSDKToolWindow.getChatWindow(p);
                if (w2 != null) {
                    return w2;
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }
}
