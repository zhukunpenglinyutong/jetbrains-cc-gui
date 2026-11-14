package com.github.claudecodegui.util;

import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Proves the JCEF availability probe, and that every entry point guarding chat-window
 * construction can link when those classes are hidden, without initializing JCEF or
 * starting Chromium.
 */
public class JcefClassAvailabilityTest {

    private static final AtomicBoolean JCEF_STATIC_INIT = new AtomicBoolean();
    private static final String PLUGIN_PACKAGE_PREFIX = "com.github.claudecodegui.";
    private static final String JCEF_MODULE_PACKAGE_PREFIX = "com.intellij.ui.jcef.";
    private static final String SURFACE_FRAME_FENCE = "com.github.claudecodegui.ui.SurfaceFrameFence";
    private static final List<String> GUARDED_ENTRY_POINTS = List.of(
            "com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow",
            "com.github.claudecodegui.action.tab.CreateNewTabAction",
            "com.github.claudecodegui.action.editor.QuickFixWithClaudeAction",
            "com.github.claudecodegui.ui.ErrorPanelBuilder",
            "com.github.claudecodegui.util.JcefMissingGuidance");

    /** Called from generated JCEF stub classes when their static initializers run. */
    public static void markJcefStaticInit() {
        JCEF_STATIC_INIT.set(true);
    }

    @Before
    public void resetStaticInitFlag() {
        JCEF_STATIC_INIT.set(false);
    }

    /** Verifies both required classes report available and the probe does not run their static initializers. */
    @Test
    public void requiredClassesAreAvailableWithoutRunningStaticInitializers() throws Exception {
        Map<String, byte[]> stubs = bothStubs();
        ClassLoader initializing = loader(stubs, Set.of(), Set.of());
        Class.forName(JcefClassAvailability.JB_CEF_BROWSER, true, initializing);
        Class.forName(JcefClassAvailability.JB_CEF_OSR_HANDLER_FACTORY, true, initializing);
        Assert.assertTrue("stub static initializers must be observable", JCEF_STATIC_INIT.get());

        JCEF_STATIC_INIT.set(false);
        Assert.assertTrue(JcefClassAvailability.isAvailable(loader(stubs, Set.of(), Set.of())));
        Assert.assertFalse(JCEF_STATIC_INIT.get());
    }

    /** Verifies hiding JBCefBrowser alone makes JCEF unavailable. */
    @Test
    public void hiddenBrowserIsUnavailable() throws Exception {
        Map<String, byte[]> stubs = Map.of(
                JcefClassAvailability.JB_CEF_OSR_HANDLER_FACTORY,
                stubClass(JcefClassAvailability.JB_CEF_OSR_HANDLER_FACTORY));
        ClassLoader loader = loader(
                stubs,
                Set.of(JcefClassAvailability.JB_CEF_BROWSER),
                Set.of());

        Assert.assertFalse(JcefClassAvailability.isAvailable(loader));
    }

    /** Verifies hiding JBCefOSRHandlerFactory alone makes JCEF unavailable. */
    @Test
    public void hiddenOsrHandlerFactoryIsUnavailable() throws Exception {
        Map<String, byte[]> stubs = Map.of(
                JcefClassAvailability.JB_CEF_BROWSER,
                stubClass(JcefClassAvailability.JB_CEF_BROWSER));
        ClassLoader loader = loader(
                stubs,
                Set.of(JcefClassAvailability.JB_CEF_OSR_HANDLER_FACTORY),
                Set.of());

        Assert.assertFalse(JcefClassAvailability.isAvailable(loader));
    }

    /** Verifies a linkage error while loading a required class is treated as unavailable. */
    @Test
    public void linkageFailureIsUnavailable() throws Exception {
        Map<String, byte[]> stubs = Map.of(
                JcefClassAvailability.JB_CEF_BROWSER,
                stubClass(JcefClassAvailability.JB_CEF_BROWSER));
        ClassLoader loader = loader(
                stubs,
                Set.of(),
                Set.of(JcefClassAvailability.JB_CEF_OSR_HANDLER_FACTORY));

        Assert.assertFalse(JcefClassAvailability.isAvailable(loader));
        Assert.assertFalse(JCEF_STATIC_INIT.get());
    }

    /**
     * Verifies every entry point that guards chat-window construction links and initializes
     * while the Web Browser (JCEF) module is absent, so its availability check can actually run.
     * All plugin classes are defined child-first, so their own references resolve with JCEF hidden.
     */
    @Test
    public void guardedEntryPointsLinkWhenJcefModuleIsHidden() throws Exception {
        ClassLoader loader = new PluginWithoutJcefModuleClassLoader(JcefClassAvailabilityTest.class.getClassLoader());

        Assert.assertFalse(JcefClassAvailability.isAvailable(loader));
        for (String entryPoint : GUARDED_ENTRY_POINTS) {
            Class<?> type = Class.forName(entryPoint, true, loader);
            Assert.assertSame(entryPoint, loader, type.getClassLoader());
        }
    }

    /**
     * Sanity check for the loader above: it reproduces the issue #1912 failure, where the chat
     * window's frame fence cannot link without JBCefOSRHandlerFactory. If the fence stops
     * needing JCEF this test must change, not the guard.
     */
    @Test
    public void hiddenJcefModuleReproducesChatWindowLinkFailure() {
        ClassLoader loader = new PluginWithoutJcefModuleClassLoader(JcefClassAvailabilityTest.class.getClassLoader());

        NoClassDefFoundError error = Assert.assertThrows(
                NoClassDefFoundError.class,
                () -> Class.forName(SURFACE_FRAME_FENCE, true, loader));
        Assert.assertTrue(error.getMessage(), error.getMessage().contains("JBCefOSRHandlerFactory"));
    }

    private static Map<String, byte[]> bothStubs() throws IOException {
        Map<String, byte[]> stubs = new HashMap<>();
        stubs.put(JcefClassAvailability.JB_CEF_BROWSER, stubClass(JcefClassAvailability.JB_CEF_BROWSER));
        stubs.put(
                JcefClassAvailability.JB_CEF_OSR_HANDLER_FACTORY,
                stubClass(JcefClassAvailability.JB_CEF_OSR_HANDLER_FACTORY));
        return stubs;
    }

    private static byte[] stubClass(String binaryName) throws IOException {
        return classWithStaticCallback(
                binaryName.replace('.', '/'),
                "com/github/claudecodegui/util/JcefClassAvailabilityTest",
                "markJcefStaticInit");
    }

    private static ClassLoader loader(
            Map<String, byte[]> defined,
            Set<String> hidden,
            Set<String> linkageFailures
    ) {
        return new FilteringClassLoader(
                JcefClassAvailabilityTest.class.getClassLoader(),
                defined,
                hidden,
                linkageFailures);
    }

    /**
     * Public class whose {@code <clinit>} invokes {@code owner.method()}.
     * Used to detect whether {@link Class#forName(String, boolean, ClassLoader)} initialized JCEF.
     */
    private static byte[] classWithStaticCallback(String internalName, String ownerInternalName, String methodName)
            throws IOException {
        List<byte[]> constantPool = new ArrayList<>();
        int thisClass = addClass(constantPool, internalName);
        int superClass = addClass(constantPool, "java/lang/Object");
        int owner = addClass(constantPool, ownerInternalName);
        int callbackName = addUtf(constantPool, methodName);
        int voidDescriptor = addUtf(constantPool, "()V");
        int callbackType = addNameAndType(constantPool, callbackName, voidDescriptor);
        int callback = addMethodRef(constantPool, owner, callbackType);
        int clinit = addUtf(constantPool, "<clinit>");
        int code = addUtf(constantPool, "Code");
        byte[] bytecode = new byte[] {
                (byte) 0xB8, (byte) (callback >> 8), (byte) callback,
                (byte) 0xB1
        };

        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bytes);
        out.writeInt(0xCAFEBABE);
        out.writeShort(0);
        out.writeShort(52);
        out.writeShort(constantPool.size() + 1);
        for (byte[] entry : constantPool) {
            out.write(entry);
        }
        out.writeShort(0x0021);
        out.writeShort(thisClass);
        out.writeShort(superClass);
        out.writeShort(0);
        out.writeShort(0);
        out.writeShort(1);
        out.writeShort(0x0008);
        out.writeShort(clinit);
        out.writeShort(voidDescriptor);
        out.writeShort(1);
        out.writeShort(code);
        out.writeInt(2 + 2 + 4 + bytecode.length + 2 + 2);
        out.writeShort(0);
        out.writeShort(0);
        out.writeInt(bytecode.length);
        out.write(bytecode);
        out.writeShort(0);
        out.writeShort(0);
        out.writeShort(0);
        return bytes.toByteArray();
    }

    private static int addUtf(List<byte[]> constantPool, String value) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bytes);
        out.writeByte(1);
        out.writeUTF(value);
        constantPool.add(bytes.toByteArray());
        return constantPool.size();
    }

    private static int addClass(List<byte[]> constantPool, String internalName) throws IOException {
        return addTaggedShort(constantPool, 7, addUtf(constantPool, internalName));
    }

    private static int addNameAndType(List<byte[]> constantPool, int nameIndex, int descriptorIndex) throws IOException {
        return addTaggedShorts(constantPool, 12, nameIndex, descriptorIndex);
    }

    private static int addMethodRef(List<byte[]> constantPool, int classIndex, int nameAndTypeIndex) throws IOException {
        return addTaggedShorts(constantPool, 10, classIndex, nameAndTypeIndex);
    }

    private static int addTaggedShort(List<byte[]> constantPool, int tag, int value) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bytes);
        out.writeByte(tag);
        out.writeShort(value);
        constantPool.add(bytes.toByteArray());
        return constantPool.size();
    }

    private static int addTaggedShorts(List<byte[]> constantPool, int tag, int first, int second) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bytes);
        out.writeByte(tag);
        out.writeShort(first);
        out.writeShort(second);
        constantPool.add(bytes.toByteArray());
        return constantPool.size();
    }

    private static final class FilteringClassLoader extends ClassLoader {
        private final Map<String, byte[]> defined;
        private final Set<String> hidden;
        private final Set<String> linkageFailures;

        private FilteringClassLoader(
                ClassLoader parent,
                Map<String, byte[]> defined,
                Set<String> hidden,
                Set<String> linkageFailures
        ) {
            super(parent);
            this.defined = defined;
            this.hidden = hidden;
            this.linkageFailures = linkageFailures;
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                if (linkageFailures.contains(name)) {
                    throw new NoClassDefFoundError(name);
                }
                Class<?> loaded = findLoadedClass(name);
                if (loaded == null) {
                    byte[] bytes = defined.get(name);
                    if (bytes != null) {
                        loaded = defineClass(name, bytes, 0, bytes.length);
                    } else if (hidden.contains(name)) {
                        throw new ClassNotFoundException(name);
                    } else {
                        loaded = super.loadClass(name, false);
                    }
                }
                if (resolve) {
                    resolveClass(loaded);
                }
                return loaded;
            }
        }
    }

    /**
     * Defines plugin classes itself (child-first) and hides the Web Browser (JCEF) module
     * package, mirroring Android Studio 2026.2+ without that plugin. Platform and JBR classes,
     * including {@code org.cef}, still come from the parent.
     */
    private static final class PluginWithoutJcefModuleClassLoader extends ClassLoader {

        private PluginWithoutJcefModuleClassLoader(ClassLoader parent) {
            super(parent);
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                if (name.startsWith(JCEF_MODULE_PACKAGE_PREFIX)) {
                    throw new ClassNotFoundException(name);
                }
                Class<?> loaded = findLoadedClass(name);
                if (loaded == null && name.startsWith(PLUGIN_PACKAGE_PREFIX)) {
                    loaded = definePluginClass(name);
                }
                if (loaded == null) {
                    loaded = super.loadClass(name, false);
                }
                if (resolve) {
                    resolveClass(loaded);
                }
                return loaded;
            }
        }

        private Class<?> definePluginClass(String name) throws ClassNotFoundException {
            String resource = name.replace('.', '/') + ".class";
            try (InputStream in = getParent().getResourceAsStream(resource)) {
                if (in == null) {
                    return null;
                }
                byte[] bytes = in.readAllBytes();
                return defineClass(name, bytes, 0, bytes.length);
            } catch (IOException e) {
                throw new ClassNotFoundException(name, e);
            }
        }
    }
}
