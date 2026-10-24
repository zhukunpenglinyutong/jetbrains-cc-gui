package com.github.claudecodegui.pet;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CodexPetWebpClassLoaderTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void separateProductLoadersReadSharedWebpWithoutHostSpiDiscovery() throws Exception {
        Path image = temporary.newFile("shared-pet.webp").toPath();
        Files.write(image, Base64.getDecoder().decode("UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABEAdQz8JUu9yBiOh/AAA="));
        var locations = new LinkedHashSet<String>();
        locations.add(location(CodexPetImageSupport.class));
        for (String type : new String[]{"com.twelvemonkeys.imageio.plugins.webp.WebPImageReaderSpi",
                "com.twelvemonkeys.imageio.spi.ImageReaderSpiBase", "com.twelvemonkeys.imageio.metadata.Directory",
                "com.twelvemonkeys.lang.Validate", "com.twelvemonkeys.io.FileUtil", "com.twelvemonkeys.image.ImageUtil"}) {
            locations.add(location(Class.forName(type)));
        }
        String executable = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", executable).toString(),
                "-cp", location(CodexPetWebpClassLoaderProcess.class), CodexPetWebpClassLoaderProcess.class.getName(),
                String.join(File.pathSeparator, locations), image.toString()).redirectErrorStream(true).start();
        try {
            assertTrue("Isolated image reader timed out", process.waitFor(20, TimeUnit.SECONDS));
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals(output, 0, process.exitValue());
            assertEquals(output, 3, output.lines().filter(line -> line.contains("host registry unchanged")).count());
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
    }

    private static String location(Class<?> type) throws Exception {
        var resource = type.getResource("/" + type.getName().replace('.', '/') + ".class");
        if (resource == null) {
            throw new java.io.IOException("Missing fixture class: " + type.getName());
        }
        if ("jar".equals(resource.getProtocol())) {
            String file = resource.getFile();
            return Path.of(java.net.URI.create(file.substring(0, file.indexOf("!/")))).toString();
        }
        Path directory = Path.of(resource.toURI()).getParent();
        for (String ignored : type.getPackageName().split("\\.")) {
            directory = directory.getParent();
        }
        return directory.toString();
    }
}
