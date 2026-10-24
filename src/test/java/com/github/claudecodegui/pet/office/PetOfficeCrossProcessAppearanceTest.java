package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class PetOfficeCrossProcessAppearanceTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void anotherJvmOwnsItsArtAndMustAcknowledgeTheDisplayFence() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary);
        assertTrue(ImageIO.write(new BufferedImage(8, 8, BufferedImage.TYPE_INT_ARGB), "png", root.resolve("pet.png").toFile()));
        var modes = new PetOfficeModeStore(root);
        try (var source = start(root); var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var endpoint = PetOfficeAppearanceCodec.endpoint(PetOfficeIpcFrameCodec.parse(source.line().getBytes(StandardCharsets.UTF_8)), "pycharm");
            var art = PetOfficeAssetChannel.catalog(endpoint, "idea", () -> true).get("pycharm/tab-0/binding-0");
            assertEquals("READY", art.status());
            byte[] bytes = PetOfficeAssetChannel.asset(endpoint, "idea", "pycharm/tab-0/binding-0", art, () -> true);
            assertArrayEquals(Files.readAllBytes(root.resolve("pet.png")), bytes);
            var entering = modes.beginEnter("idea-leader", lease);
            assertEquals(1, entering.participants().size()); assertFalse(modes.commitOffice(entering, lease));
            source.send("ACK"); assertEquals("ACKNOWLEDGED", source.line()); assertTrue(modes.commitOffice(entering, lease));
            var next = modes.beginEnter("replacement-leader", lease); assertFalse(modes.commitOffice(next, lease));
            source.send("RETIRE"); assertEquals("RETIRED", source.line()); assertTrue(modes.commitOffice(next, lease));
        }
    }

    @Test public void aControlledSourceCrashCannotLeaveAnUnacknowledgedLiveProcessBehind() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary); var modes = new PetOfficeModeStore(root);
        try (var source = start(root); var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            assertNotNull(source.line()); var entering = modes.beginEnter("leader", lease);
            assertFalse(modes.commitOffice(entering, lease)); source.close(); assertTrue(modes.commitOffice(entering, lease));
        }
    }

    private static Peer start(Path root) throws Exception {
        String classpath = location(PetOfficeAppearanceProcess.class) + File.pathSeparator + location(PetOfficeAssetChannel.class) + File.pathSeparator + location(Gson.class);
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java.exe").toString(), "-cp", classpath,
                PetOfficeAppearanceProcess.class.getName(), root.toString()).redirectError(ProcessBuilder.Redirect.DISCARD).start();
        return new Peer(process);
    }
    private static Path location(Class<?> type) throws Exception {
        var resource = type.getResource("/" + type.getName().replace('.', '/') + ".class");
        if (resource == null) throw new IOException("Missing fixture class");
        if (resource.getProtocol().equals("jar")) {
            String file = resource.getFile(); return Path.of(URI.create(file.substring(0, file.indexOf("!/"))));
        }
        Path directory = Path.of(resource.toURI()).getParent();
        for (String ignored : type.getPackageName().split("\\.")) directory = directory.getParent();
        return directory;
    }
    private static final class Peer implements AutoCloseable {
        private final Process process;
        private final BufferedReader output;
        private Peer(Process process) { this.process = process; output = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)); }
        private String line() throws Exception {
            var reader = Executors.newSingleThreadExecutor(task -> PetOfficeIpcServer.daemon(task, "Office child output"));
            try { return reader.submit(output::readLine).get(10, TimeUnit.SECONDS); } finally { reader.shutdownNow(); }
        }
        private void send(String command) throws IOException {
            process.getOutputStream().write((command + "\n").getBytes(StandardCharsets.UTF_8)); process.getOutputStream().flush();
        }
        @Override public void close() throws Exception { process.destroyForcibly(); assertTrue(process.waitFor(10, TimeUnit.SECONDS)); }
    }
}
