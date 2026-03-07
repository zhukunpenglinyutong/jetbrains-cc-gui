# Project-Level Prompts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add project-level prompt storage alongside existing global prompts, with independent management for each scope.

**Architecture:** Refactor existing `PromptManager` into abstract base class with two concrete implementations: `GlobalPromptManager` (uses `~/.codemoss/prompt.json`) and `ProjectPromptManager` (uses `<project>/.codemoss/prompt.json`). Factory pattern creates appropriate manager based on scope.

**Tech Stack:** Java (IntelliJ Platform), TypeScript/React, Gson for JSON

---

## Phase 1: Backend - Core Architecture

### Task 1: Create PromptScope Enum

**Files:**
- Create: `src/main/java/com/github/claudecodegui/model/PromptScope.java`

**Step 1: Write the failing test**

```java
// src/test/java/com/github/claudecodegui/model/PromptScopeTest.java
package com.github.claudecodegui.model;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class PromptScopeTest {

    @Test
    public void testFromString_Global() {
        assertEquals(PromptScope.GLOBAL, PromptScope.fromString("global"));
    }

    @Test
    public void testFromString_Project() {
        assertEquals(PromptScope.PROJECT, PromptScope.fromString("project"));
    }

    @Test
    public void testFromString_Invalid() {
        assertThrows(IllegalArgumentException.class, () -> {
            PromptScope.fromString("invalid");
        });
    }

    @Test
    public void testGetValue() {
        assertEquals("global", PromptScope.GLOBAL.getValue());
        assertEquals("project", PromptScope.PROJECT.getValue());
    }
}
```

**Step 2: Run test to verify it fails**

Run: `./gradlew test --tests PromptScopeTest`
Expected: FAIL with "class not found"

**Step 3: Write minimal implementation**

```java
// src/main/java/com/github/claudecodegui/model/PromptScope.java
package com.github.claudecodegui.model;

public enum PromptScope {
    GLOBAL("global"),
    PROJECT("project");

    private final String value;

    PromptScope(String value) {
        this.value = value;
    }

    public String getValue() {
        return value;
    }

    public static PromptScope fromString(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Scope value cannot be null");
        }

        for (PromptScope scope : values()) {
            if (scope.value.equals(value)) {
                return scope;
            }
        }
        throw new IllegalArgumentException("Unknown scope: " + value);
    }
}
```

**Step 4: Run test to verify it passes**

Run: `./gradlew test --tests PromptScopeTest`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/java/com/github/claudecodegui/model/PromptScope.java src/test/java/com/github/claudecodegui/model/PromptScopeTest.java
git commit -m "feat: add PromptScope enum for global/project scopes"
```

---

### Task 2: Refactor PromptManager to AbstractPromptManager

**Files:**
- Rename: `src/main/java/com/github/claudecodegui/settings/PromptManager.java` → `src/main/java/com/github/claudecodegui/settings/AbstractPromptManager.java`
- Modify: `src/main/java/com/github/claudecodegui/settings/AbstractPromptManager.java`

**Step 1: Write tests for abstract manager (test global manager will validate this)**

```java
// src/test/java/com/github/claudecodegui/settings/AbstractPromptManagerTest.java
package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

public class AbstractPromptManagerTest {

    // Test implementation for testing abstract class
    static class TestPromptManager extends AbstractPromptManager {
        private final Path storagePath;

        public TestPromptManager(Gson gson, Path storagePath) {
            super(gson);
            this.storagePath = storagePath;
        }

        @Override
        protected Path getStoragePath() {
            return storagePath;
        }

        @Override
        protected void ensureStorageDirectory() throws IOException {
            Path parent = storagePath.getParent();
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent);
            }
        }
    }

    @Test
    public void testAddAndGetPrompt(@TempDir Path tempDir) throws IOException {
        Path promptFile = tempDir.resolve("prompt.json");
        Gson gson = new Gson();
        TestPromptManager manager = new TestPromptManager(gson, promptFile);

        JsonObject prompt = new JsonObject();
        prompt.addProperty("id", "test-1");
        prompt.addProperty("name", "Test Prompt");
        prompt.addProperty("content", "Test content");

        manager.addPrompt(prompt);

        List<JsonObject> prompts = manager.getPrompts();
        assertEquals(1, prompts.size());
        assertEquals("test-1", prompts.get(0).get("id").getAsString());
    }

    @Test
    public void testUpdatePrompt(@TempDir Path tempDir) throws IOException {
        Path promptFile = tempDir.resolve("prompt.json");
        Gson gson = new Gson();
        TestPromptManager manager = new TestPromptManager(gson, promptFile);

        // Add a prompt
        JsonObject prompt = new JsonObject();
        prompt.addProperty("id", "test-1");
        prompt.addProperty("name", "Original");
        prompt.addProperty("content", "Original content");
        manager.addPrompt(prompt);

        // Update it
        JsonObject updates = new JsonObject();
        updates.addProperty("name", "Updated");
        manager.updatePrompt("test-1", updates);

        JsonObject updated = manager.getPrompt("test-1");
        assertEquals("Updated", updated.get("name").getAsString());
    }

    @Test
    public void testDeletePrompt(@TempDir Path tempDir) throws IOException {
        Path promptFile = tempDir.resolve("prompt.json");
        Gson gson = new Gson();
        TestPromptManager manager = new TestPromptManager(gson, promptFile);

        JsonObject prompt = new JsonObject();
        prompt.addProperty("id", "test-1");
        prompt.addProperty("name", "Test");
        prompt.addProperty("content", "Test");
        manager.addPrompt(prompt);

        boolean deleted = manager.deletePrompt("test-1");
        assertTrue(deleted);

        List<JsonObject> prompts = manager.getPrompts();
        assertEquals(0, prompts.size());
    }
}
```

**Step 2: Run test to verify it fails**

Run: `./gradlew test --tests AbstractPromptManagerTest`
Expected: FAIL (class not found)

**Step 3: Refactor PromptManager to AbstractPromptManager**

```bash
# Rename the file
git mv src/main/java/com/github/claudecodegui/settings/PromptManager.java src/main/java/com/github/claudecodegui/settings/AbstractPromptManager.java
```

**Step 4: Make the class abstract and extract template methods**

Modify `src/main/java/com/github/claudecodegui/settings/AbstractPromptManager.java`:

```java
package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.ConflictStrategy;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Abstract Prompt Manager.
 * Base class for managing prompt library configuration.
 */
public abstract class AbstractPromptManager {
    private static final Logger LOG = Logger.getInstance(AbstractPromptManager.class);

    /**
     * Valid prompt ID pattern: UUID format or numeric timestamp string.
     * Rejects IDs containing path separators, whitespace, or special characters.
     */
    private static final Pattern VALID_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9\\-]{1,64}$");

    protected final Gson gson;

    public AbstractPromptManager(Gson gson) {
        this.gson = gson;
    }

    /**
     * Get the storage path for prompts.
     * Subclasses must implement this to specify their storage location.
     */
    protected abstract Path getStoragePath() throws IOException;

    /**
     * Ensure the storage directory exists.
     * Subclasses must implement this to create necessary directories.
     */
    protected abstract void ensureStorageDirectory() throws IOException;

    /**
     * Read the prompt.json file.
     */
    public JsonObject readPromptConfig() throws IOException {
        Path promptPath = getStoragePath();

        if (!Files.exists(promptPath)) {
            // Return an empty config
            JsonObject config = new JsonObject();
            config.add("prompts", new JsonObject());
            return config;
        }

        try (BufferedReader reader = Files.newBufferedReader(promptPath, StandardCharsets.UTF_8)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            // Ensure the prompts node exists
            if (!config.has("prompts")) {
                config.add("prompts", new JsonObject());
            }
            return config;
        } catch (Exception e) {
            LOG.warn("[AbstractPromptManager] Failed to read prompt.json: " + e.getMessage());
            JsonObject config = new JsonObject();
            config.add("prompts", new JsonObject());
            return config;
        }
    }

    /**
     * Write the prompt.json file.
     */
    public void writePromptConfig(JsonObject config) throws IOException {
        ensureStorageDirectory();

        Path promptPath = getStoragePath();
        try (BufferedWriter writer = Files.newBufferedWriter(promptPath, StandardCharsets.UTF_8)) {
            gson.toJson(config, writer);
            LOG.debug("[AbstractPromptManager] Successfully wrote prompt.json");
        } catch (Exception e) {
            LOG.warn("[AbstractPromptManager] Failed to write prompt.json: " + e.getMessage());
            throw e;
        }
    }

    // ... (keep all other methods from PromptManager unchanged)
    // getPrompts(), addPrompt(), updatePrompt(), deletePrompt(), getPrompt()
    // validatePrompt(), detectConflicts(), generateUniqueId(), batchImportPrompts()
}
```

**Step 5: Run test to verify it passes**

Run: `./gradlew test --tests AbstractPromptManagerTest`
Expected: PASS

**Step 6: Commit**

```bash
git add .
git commit -m "refactor: convert PromptManager to AbstractPromptManager

- Rename PromptManager to AbstractPromptManager
- Extract getStoragePath() and ensureStorageDirectory() as abstract methods
- Add tests for abstract manager functionality"
```

---

### Task 3: Create GlobalPromptManager

**Files:**
- Create: `src/main/java/com/github/claudecodegui/settings/GlobalPromptManager.java`

**Step 1: Write the failing test**

```java
// src/test/java/com/github/claudecodegui/settings/GlobalPromptManagerTest.java
package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

public class GlobalPromptManagerTest {

    @Test
    public void testGlobalPromptManager(@TempDir Path tempDir) throws IOException {
        Gson gson = new Gson();

        // Create mock ConfigPathManager
        ConfigPathManager pathManager = new ConfigPathManager() {
            @Override
            public Path getPromptFilePath() {
                return tempDir.resolve("prompt.json");
            }

            @Override
            public void ensureConfigDirectory() throws IOException {
                if (!Files.exists(tempDir)) {
                    Files.createDirectories(tempDir);
                }
            }
        };

        GlobalPromptManager manager = new GlobalPromptManager(gson, pathManager);

        JsonObject prompt = new JsonObject();
        prompt.addProperty("id", "global-1");
        prompt.addProperty("name", "Global Prompt");
        prompt.addProperty("content", "Global content");

        manager.addPrompt(prompt);

        List<JsonObject> prompts = manager.getPrompts();
        assertEquals(1, prompts.size());
        assertEquals("global-1", prompts.get(0).get("id").getAsString());
    }

    @Test
    public void testGetStoragePath(@TempDir Path tempDir) throws IOException {
        Gson gson = new Gson();
        Path expectedPath = tempDir.resolve("prompt.json");

        ConfigPathManager pathManager = new ConfigPathManager() {
            @Override
            public Path getPromptFilePath() {
                return expectedPath;
            }
        };

        GlobalPromptManager manager = new GlobalPromptManager(gson, pathManager);
        assertEquals(expectedPath, manager.getStoragePath());
    }
}
```

**Step 2: Run test to verify it fails**

Run: `./gradlew test --tests GlobalPromptManagerTest`
Expected: FAIL (class not found)

**Step 3: Write minimal implementation**

```java
// src/main/java/com/github/claudecodegui/settings/GlobalPromptManager.java
package com.github.claudecodegui.settings;

import com.google.gson.Gson;

import java.io.IOException;
import java.nio.file.Path;

/**
 * Global Prompt Manager.
 * Manages prompts stored in ~/.codemoss/prompt.json
 */
public class GlobalPromptManager extends AbstractPromptManager {

    private final ConfigPathManager pathManager;

    public GlobalPromptManager(Gson gson, ConfigPathManager pathManager) {
        super(gson);
        this.pathManager = pathManager;
    }

    @Override
    protected Path getStoragePath() {
        return pathManager.getPromptFilePath();
    }

    @Override
    protected void ensureStorageDirectory() throws IOException {
        pathManager.ensureConfigDirectory();
    }
}
```

**Step 4: Run test to verify it passes**

Run: `./gradlew test --tests GlobalPromptManagerTest`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/GlobalPromptManager.java src/test/java/com/github/claudecodegui/settings/GlobalPromptManagerTest.java
git commit -m "feat: add GlobalPromptManager for global prompts

- Extends AbstractPromptManager
- Uses ~/.codemoss/prompt.json for storage
- Delegates path management to ConfigPathManager"
```

---

### Task 4: Create ProjectPromptManager

**Files:**
- Create: `src/main/java/com/github/claudecodegui/settings/ProjectPromptManager.java`

**Step 1: Write the failing test**

```java
// src/test/java/com/github/claudecodegui/settings/ProjectPromptManagerTest.java
package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

public class ProjectPromptManagerTest {

    @Test
    public void testProjectPromptManager(@TempDir Path tempDir) throws IOException {
        Gson gson = new Gson();

        // Mock Project
        Project project = mock(Project.class);
        when(project.getBasePath()).thenReturn(tempDir.toString());

        ProjectPromptManager manager = new ProjectPromptManager(gson, project);

        JsonObject prompt = new JsonObject();
        prompt.addProperty("id", "project-1");
        prompt.addProperty("name", "Project Prompt");
        prompt.addProperty("content", "Project content");

        manager.addPrompt(prompt);

        List<JsonObject> prompts = manager.getPrompts();
        assertEquals(1, prompts.size());
        assertEquals("project-1", prompts.get(0).get("id").getAsString());
    }

    @Test
    public void testGetStoragePath(@TempDir Path tempDir) throws IOException {
        Gson gson = new Gson();

        Project project = mock(Project.class);
        when(project.getBasePath()).thenReturn(tempDir.toString());

        ProjectPromptManager manager = new ProjectPromptManager(gson, project);
        Path storagePath = manager.getStoragePath();

        assertEquals(tempDir.resolve(".codemoss").resolve("prompt.json"), storagePath);
    }

    @Test
    public void testNullProject() {
        Gson gson = new Gson();
        ProjectPromptManager manager = new ProjectPromptManager(gson, null);

        assertThrows(IllegalStateException.class, () -> {
            manager.getStoragePath();
        });
    }

    @Test
    public void testProjectWithoutBasePath() {
        Gson gson = new Gson();
        Project project = mock(Project.class);
        when(project.getBasePath()).thenReturn(null);

        ProjectPromptManager manager = new ProjectPromptManager(gson, project);

        assertThrows(IllegalStateException.class, () -> {
            manager.getStoragePath();
        });
    }
}
```

**Step 2: Run test to verify it fails**

Run: `./gradlew test --tests ProjectPromptManagerTest`
Expected: FAIL (class not found)

**Step 3: Write minimal implementation**

```java
// src/main/java/com/github/claudecodegui/settings/ProjectPromptManager.java
package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.intellij.openapi.project.Project;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Project Prompt Manager.
 * Manages prompts stored in <project>/.codemoss/prompt.json
 */
public class ProjectPromptManager extends AbstractPromptManager {

    private final Project project;

    public ProjectPromptManager(Gson gson, Project project) {
        super(gson);
        this.project = project;
    }

    @Override
    protected Path getStoragePath() {
        if (project == null || project.getBasePath() == null) {
            throw new IllegalStateException("Project not available or project base path is null");
        }
        return Paths.get(project.getBasePath(), ".codemoss", "prompt.json");
    }

    @Override
    protected void ensureStorageDirectory() throws IOException {
        Path dir = getStoragePath().getParent();
        if (dir != null && !Files.exists(dir)) {
            Files.createDirectories(dir);
        }
    }
}
```

**Step 4: Run test to verify it passes**

Run: `./gradlew test --tests ProjectPromptManagerTest`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/ProjectPromptManager.java src/test/java/com/github/claudecodegui/settings/ProjectPromptManagerTest.java
git commit -m "feat: add ProjectPromptManager for project prompts

- Extends AbstractPromptManager
- Uses <project>/.codemoss/prompt.json for storage
- Validates project availability before operations"
```

---

### Task 5: Create PromptManagerFactory

**Files:**
- Create: `src/main/java/com/github/claudecodegui/settings/PromptManagerFactory.java`

**Step 1: Write the failing test**

```java
// src/test/java/com/github/claudecodegui/settings/PromptManagerFactoryTest.java
package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.PromptScope;
import com.google.gson.Gson;
import com.intellij.openapi.project.Project;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

public class PromptManagerFactoryTest {

    @Test
    public void testCreateGlobalManager() {
        Gson gson = new Gson();
        ConfigPathManager pathManager = new ConfigPathManager();
        Project project = mock(Project.class);

        AbstractPromptManager manager = PromptManagerFactory.create(
            PromptScope.GLOBAL, gson, pathManager, project
        );

        assertNotNull(manager);
        assertTrue(manager instanceof GlobalPromptManager);
    }

    @Test
    public void testCreateProjectManager() {
        Gson gson = new Gson();
        ConfigPathManager pathManager = new ConfigPathManager();
        Project project = mock(Project.class);
        when(project.getBasePath()).thenReturn("/path/to/project");

        AbstractPromptManager manager = PromptManagerFactory.create(
            PromptScope.PROJECT, gson, pathManager, project
        );

        assertNotNull(manager);
        assertTrue(manager instanceof ProjectPromptManager);
    }

    @Test
    public void testCreateProjectManager_NullProject() {
        Gson gson = new Gson();
        ConfigPathManager pathManager = new ConfigPathManager();

        assertThrows(IllegalArgumentException.class, () -> {
            PromptManagerFactory.create(PromptScope.PROJECT, gson, pathManager, null);
        });
    }
}
```

**Step 2: Run test to verify it fails**

Run: `./gradlew test --tests PromptManagerFactoryTest`
Expected: FAIL (class not found)

**Step 3: Write minimal implementation**

```java
// src/main/java/com/github/claudecodegui/settings/PromptManagerFactory.java
package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.PromptScope;
import com.google.gson.Gson;
import com.intellij.openapi.project.Project;

/**
 * Factory for creating PromptManager instances based on scope.
 */
public class PromptManagerFactory {

    /**
     * Create a PromptManager for the given scope.
     *
     * @param scope The scope (GLOBAL or PROJECT)
     * @param gson Gson instance for JSON serialization
     * @param pathManager Configuration path manager (used for global scope)
     * @param project Project instance (required for PROJECT scope)
     * @return AbstractPromptManager instance
     * @throws IllegalArgumentException if project is null for PROJECT scope
     */
    public static AbstractPromptManager create(
        PromptScope scope,
        Gson gson,
        ConfigPathManager pathManager,
        Project project
    ) {
        switch (scope) {
            case GLOBAL:
                return new GlobalPromptManager(gson, pathManager);

            case PROJECT:
                if (project == null) {
                    throw new IllegalArgumentException("Project required for PROJECT scope");
                }
                return new ProjectPromptManager(gson, project);

            default:
                throw new IllegalArgumentException("Unknown scope: " + scope);
        }
    }
}
```

**Step 4: Run test to verify it passes**

Run: `./gradlew test --tests PromptManagerFactoryTest`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/PromptManagerFactory.java src/test/java/com/github/claudecodegui/settings/PromptManagerFactoryTest.java
git commit -m "feat: add PromptManagerFactory for scope-based manager creation

- Factory pattern for creating global or project managers
- Validates project requirement for PROJECT scope
- Centralized manager creation logic"
```

---

### Task 6: Update CodemossSettingsService

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/CodemossSettingsService.java:40,77`

**Step 1: Write tests for scope-based operations**

```java
// Add to existing CodemossSettingsService tests or create new test file
@Test
public void testGetPromptManager_Global() {
    CodemossSettingsService service = new CodemossSettingsService();
    AbstractPromptManager manager = service.getPromptManager(PromptScope.GLOBAL);
    assertNotNull(manager);
    assertTrue(manager instanceof GlobalPromptManager);
}

@Test
public void testGetPrompts_WithScope() throws IOException {
    CodemossSettingsService service = new CodemossSettingsService();
    List<JsonObject> globalPrompts = service.getPrompts(PromptScope.GLOBAL);
    assertNotNull(globalPrompts);
}
```

**Step 2: Run test to verify it fails**

Run: `./gradlew test --tests CodemossSettingsServiceTest`
Expected: FAIL (methods not found)

**Step 3: Update CodemossSettingsService**

Modify `src/main/java/com/github/claudecodegui/CodemossSettingsService.java`:

```java
// Remove the old promptManager field and replace with:
private final Project project;

// In constructor, add:
public CodemossSettingsService(Project project) {
    this.project = project;
    // ... existing initialization
}

// Replace old prompt methods with scope-aware versions:
/**
 * Get prompt manager for specified scope.
 */
public AbstractPromptManager getPromptManager(PromptScope scope) {
    return PromptManagerFactory.create(scope, gson, pathManager, project);
}

/**
 * Get prompts for specified scope.
 */
public List<JsonObject> getPrompts(PromptScope scope) throws IOException {
    return getPromptManager(scope).getPrompts();
}

/**
 * Add prompt to specified scope.
 */
public void addPrompt(PromptScope scope, JsonObject prompt) throws IOException {
    getPromptManager(scope).addPrompt(prompt);
}

/**
 * Update prompt in specified scope.
 */
public void updatePrompt(PromptScope scope, String id, JsonObject updates) throws IOException {
    getPromptManager(scope).updatePrompt(id, updates);
}

/**
 * Delete prompt from specified scope.
 */
public boolean deletePrompt(PromptScope scope, String id) throws IOException {
    return getPromptManager(scope).deletePrompt(id);
}

/**
 * Get single prompt from specified scope.
 */
public JsonObject getPrompt(PromptScope scope, String id) throws IOException {
    return getPromptManager(scope).getPrompt(id);
}

// Keep old methods for backward compatibility (default to GLOBAL):
/**
 * @deprecated Use getPrompts(PromptScope) instead
 */
@Deprecated
public List<JsonObject> getPrompts() throws IOException {
    return getPrompts(PromptScope.GLOBAL);
}

/**
 * @deprecated Use getPromptManager(PromptScope) instead
 */
@Deprecated
public AbstractPromptManager getPromptManager() {
    return getPromptManager(PromptScope.GLOBAL);
}

// Similar deprecation for addPrompt, updatePrompt, deletePrompt without scope parameter
```

**Step 4: Run test to verify it passes**

Run: `./gradlew test --tests CodemossSettingsServiceTest`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/java/com/github/claudecodegui/CodemossSettingsService.java
git commit -m "refactor: add scope-aware prompt methods to CodemossSettingsService

- Add getPromptManager(PromptScope) method
- Add scope parameter to all prompt operations
- Deprecate old methods for backward compatibility
- Use factory pattern for manager creation"
```

---

### Task 7: Update PromptHandler for Scope Support

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/handler/PromptHandler.java`

**Step 1: Add tests for scope parameter**

```java
// Integration test for PromptHandler with scope
@Test
public void testHandleGetPrompts_GlobalScope() {
    PromptHandler handler = new PromptHandler(context);

    JsonObject request = new JsonObject();
    request.addProperty("scope", "global");

    boolean handled = handler.handle("get_prompts", gson.toJson(request));
    assertTrue(handled);
}

@Test
public void testHandleAddPrompt_ProjectScope() {
    PromptHandler handler = new PromptHandler(context);

    JsonObject request = new JsonObject();
    request.addProperty("scope", "project");

    JsonObject prompt = new JsonObject();
    prompt.addProperty("id", "test-1");
    prompt.addProperty("name", "Test");
    prompt.addProperty("content", "Test");
    request.add("prompt", prompt);

    boolean handled = handler.handle("add_prompt", gson.toJson(request));
    assertTrue(handled);
}
```

**Step 2: Run test to verify it fails**

Run: `./gradlew test --tests PromptHandlerTest`
Expected: FAIL (scope not parsed)

**Step 3: Update PromptHandler methods**

Modify `src/main/java/com/github/claudecodegui/handler/PromptHandler.java`:

```java
// Add new message types to SUPPORTED_TYPES:
private static final String[] SUPPORTED_TYPES = {
    "get_prompts",
    "add_prompt",
    "update_prompt",
    "delete_prompt",
    "export_prompts",
    "import_prompts_file",
    "save_imported_prompts",
    "copy_prompt_to_global",  // NEW
    "get_project_info"         // NEW
};

// Update handleGetPrompts to accept scope:
private void handleGetPrompts(String content) {
    try {
        // Parse scope from content
        PromptScope scope = PromptScope.GLOBAL; // default
        if (content != null && !content.isEmpty()) {
            JsonObject data = gson.fromJson(content, JsonObject.class);
            if (data.has("scope")) {
                scope = PromptScope.fromString(data.get("scope").getAsString());
            }
        }

        List<JsonObject> prompts = settingsService.getPrompts(scope);
        String promptsJson = gson.toJson(prompts);

        final String scopeValue = scope.getValue();
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.updatePrompts",
                escapeJs("'" + scopeValue + "'"),
                escapeJs(promptsJson));
        });
    } catch (Exception e) {
        LOG.error("[PromptHandler] Failed to get prompts: " + e.getMessage(), e);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.updatePrompts", escapeJs("'global'"), escapeJs("[]"));
        });
    }
}

// Update handleAddPrompt:
private void handleAddPrompt(String content) {
    try {
        JsonObject data = gson.fromJson(content, JsonObject.class);

        PromptScope scope = PromptScope.GLOBAL;
        if (data.has("scope")) {
            scope = PromptScope.fromString(data.get("scope").getAsString());
        }

        JsonObject prompt = data.has("prompt") ?
            data.getAsJsonObject("prompt") : data;

        settingsService.addPrompt(scope, prompt);

        final PromptScope finalScope = scope;
        ApplicationManager.getApplication().invokeLater(() -> {
            handleGetPrompts(gson.toJson(createScopeRequest(finalScope)));
            callJavaScript("window.promptOperationResult",
                escapeJs("{\"success\":true,\"operation\":\"add\",\"scope\":\"" + finalScope.getValue() + "\"}"));
        });
    } catch (Exception e) {
        // ... error handling
    }
}

// Add helper method:
private JsonObject createScopeRequest(PromptScope scope) {
    JsonObject request = new JsonObject();
    request.addProperty("scope", scope.getValue());
    return request;
}

// Similar updates for handleUpdatePrompt, handleDeletePrompt, handleExportPrompts, handleImportPromptsFile, handleSaveImportedPrompts

// Add new handler for copy to global:
private void handleCopyPromptToGlobal(String content) {
    try {
        JsonObject data = gson.fromJson(content, JsonObject.class);

        if (!data.has("promptId")) {
            sendErrorResult("copy", "Missing promptId field");
            return;
        }

        String promptId = data.get("promptId").getAsString();

        // Get prompt from project scope
        JsonObject prompt = settingsService.getPrompt(PromptScope.PROJECT, promptId);
        if (prompt == null) {
            sendErrorResult("copy", "Prompt not found in project");
            return;
        }

        // Generate new ID for global scope to avoid conflicts
        String newId = UUID.randomUUID().toString();
        prompt.addProperty("id", newId);
        prompt.addProperty("createdAt", System.currentTimeMillis());
        prompt.remove("updatedAt");

        // Add to global scope
        settingsService.addPrompt(PromptScope.GLOBAL, prompt);

        ApplicationManager.getApplication().invokeLater(() -> {
            handleGetPrompts(gson.toJson(createScopeRequest(PromptScope.GLOBAL)));
            callJavaScript("window.promptOperationResult",
                escapeJs("{\"success\":true,\"operation\":\"copy\"}"));
        });

    } catch (Exception e) {
        LOG.error("[PromptHandler] Failed to copy prompt to global: " + e.getMessage(), e);
        sendErrorResult("copy", e.getMessage());
    }
}

// Add handler for project info:
private void handleGetProjectInfo() {
    try {
        Project project = context.getProject();
        JsonObject projectInfo = new JsonObject();

        if (project != null && project.getBasePath() != null) {
            projectInfo.addProperty("name", project.getName());
            projectInfo.addProperty("path", project.getBasePath());
            projectInfo.addProperty("available", true);
        } else {
            projectInfo.addProperty("available", false);
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.updateProjectInfo", escapeJs(gson.toJson(projectInfo)));
        });
    } catch (Exception e) {
        LOG.error("[PromptHandler] Failed to get project info: " + e.getMessage(), e);
    }
}

// Update handle() method switch:
@Override
public boolean handle(String type, String content) {
    switch (type) {
        case "get_prompts":
            handleGetPrompts(content);  // Now accepts content
            return true;
        case "add_prompt":
            handleAddPrompt(content);
            return true;
        // ... other cases
        case "copy_prompt_to_global":
            handleCopyPromptToGlobal(content);
            return true;
        case "get_project_info":
            handleGetProjectInfo();
            return true;
        default:
            return false;
    }
}
```

**Step 4: Run test to verify it passes**

Run: `./gradlew test --tests PromptHandlerTest`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/java/com/github/claudecodegui/handler/PromptHandler.java
git commit -m "feat: add scope support to PromptHandler

- Parse scope parameter from all prompt operations
- Add copy_prompt_to_global handler
- Add get_project_info handler
- Update callbacks to include scope information"
```

---

## Phase 2: Frontend - Type Definitions and Models

### Task 8: Extend TypeScript Types

**Files:**
- Modify: `webview/src/types/prompt.ts`
- Create: `webview/src/types/scope.ts`

**Step 1: Create scope types**

```typescript
// webview/src/types/scope.ts
export type PromptScope = 'global' | 'project';

export interface ScopedOperation {
  scope: PromptScope;
}
```

**Step 2: Extend PromptConfig**

```typescript
// webview/src/types/prompt.ts
export interface PromptConfig {
  id: string;
  name: string;
  content: string;
  scope?: PromptScope;  // NEW: optional, added during fetch
  createdAt?: number;
  updatedAt?: number;
}

export interface ProjectInfo {
  name?: string;
  path?: string;
  available: boolean;
}
```

**Step 3: Commit**

```bash
git add webview/src/types/scope.ts webview/src/types/prompt.ts
git commit -m "feat: add scope types for frontend

- Add PromptScope type
- Add ProjectInfo interface
- Extend PromptConfig with optional scope field"
```

---

### Task 9: Update usePromptManagement Hook

**Files:**
- Modify: `webview/src/components/settings/hooks/usePromptManagement.ts`

**Step 1: Add project state and handlers**

```typescript
// Add new state:
const [projectPrompts, setProjectPrompts] = useState<PromptConfig[]>([]);
const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);

// Update loadPrompts to load both scopes:
const loadPrompts = useCallback(() => {
  const TIMEOUT = 2000;

  setPromptsLoading(true);

  // Load global prompts
  sendToJava('get_prompts:' + JSON.stringify({ scope: 'global' }));

  // Load project prompts
  sendToJava('get_prompts:' + JSON.stringify({ scope: 'project' }));

  // Get project info
  sendToJava('get_project_info:');

  const timeoutId = setTimeout(() => {
    setPromptsLoading(false);
  }, TIMEOUT);

  promptsLoadingTimeoutRef.current = timeoutId;
}, []);

// Update updatePrompts to handle scope:
const updatePrompts = useCallback((scope: PromptScope, promptsList: PromptConfig[]) => {
  if (promptsLoadingTimeoutRef.current) {
    clearTimeout(promptsLoadingTimeoutRef.current);
    promptsLoadingTimeoutRef.current = null;
  }

  if (scope === 'global') {
    setPrompts(promptsList);
  } else {
    setProjectPrompts(promptsList);
  }

  setPromptsLoading(false);
}, []);

// Add updateProjectInfo handler:
const updateProjectInfo = useCallback((info: ProjectInfo) => {
  setProjectInfo(info);
}, []);

// Update handleAdd, handleSave, handleDelete to include scope parameter:
const handleAddPrompt = useCallback((scope: PromptScope) => {
  setPromptDialog({ isOpen: true, prompt: null, scope });
}, []);

const handleSavePrompt = useCallback(
  (data: { name: string; content: string }, scope: PromptScope) => {
    const isAdding = !promptDialog.prompt;

    if (isAdding) {
      const newPrompt = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
        name: data.name,
        content: data.content,
        createdAt: Date.now(),
      };
      sendToJava(`add_prompt:${JSON.stringify({ scope, prompt: newPrompt })}`);
    } else if (promptDialog.prompt) {
      const updateData = {
        scope,
        id: promptDialog.prompt.id,
        updates: {
          name: data.name,
          content: data.content,
          updatedAt: Date.now(),
        },
      };
      sendToJava(`update_prompt:${JSON.stringify(updateData)}`);
    }

    setPromptDialog({ isOpen: false, prompt: null, scope: null });
    loadPrompts();
  },
  [promptDialog.prompt, loadPrompts]
);

// Add copy to global handler:
const handleCopyToGlobal = useCallback((prompt: PromptConfig) => {
  const data = { promptId: prompt.id };
  sendToJava(`copy_prompt_to_global:${JSON.stringify(data)}`);
  loadPrompts();
}, [loadPrompts]);

// Return updated values:
return {
  // ... existing returns
  projectPrompts,
  projectInfo,
  updateProjectInfo,
  handleCopyToGlobal,
};
```

**Step 2: Commit**

```bash
git add webview/src/components/settings/hooks/usePromptManagement.ts
git commit -m "feat: add scope support to usePromptManagement hook

- Add project prompts state
- Add project info state
- Update all handlers to support scope parameter
- Add copy to global functionality"
```

---

### Task 10: Create PromptScopeSection Component

**Files:**
- Create: `webview/src/components/settings/PromptSection/PromptScopeSection.tsx`
- Create: `webview/src/components/settings/PromptSection/PromptScopeSection.module.less`

**Step 1: Create component structure**

```typescript
// webview/src/components/settings/PromptSection/PromptScopeSection.tsx
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptConfig } from '../../../types/prompt';
import type { PromptScope } from '../../../types/scope';
import styles from './PromptScopeSection.module.less';

interface PromptScopeSectionProps {
  title: string;
  scope: PromptScope;
  prompts: PromptConfig[];
  loading: boolean;
  showCopyToGlobal?: boolean;
  onAdd: () => void;
  onEdit: (prompt: PromptConfig) => void;
  onDelete: (prompt: PromptConfig) => void;
  onExport: () => void;
  onImport: () => void;
  onCopyToGlobal?: (prompt: PromptConfig) => void;
}

export default function PromptScopeSection({
  title,
  scope,
  prompts,
  loading,
  showCopyToGlobal = false,
  onAdd,
  onEdit,
  onDelete,
  onExport,
  onImport,
  onCopyToGlobal,
}: PromptScopeSectionProps) {
  const { t } = useTranslation();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleMenuToggle = (promptId: string) => {
    setOpenMenuId(openMenuId === promptId ? null : promptId);
  };

  const handleEditClick = (prompt: PromptConfig) => {
    setOpenMenuId(null);
    onEdit(prompt);
  };

  const handleDeleteClick = (prompt: PromptConfig) => {
    setOpenMenuId(null);
    onDelete(prompt);
  };

  const handleCopyClick = (prompt: PromptConfig) => {
    setOpenMenuId(null);
    onCopyToGlobal?.(prompt);
  };

  return (
    <div className={styles.scopeSection}>
      <div className={styles.header}>
        <h4 className={styles.title}>{title}</h4>
        <div className={styles.actions}>
          <button className={styles.actionButton} onClick={onExport}>
            <span className="codicon codicon-export" />
            {t('settings.prompt.export')}
          </button>
          <button className={styles.actionButton} onClick={onImport}>
            <span className="codicon codicon-cloud-download" />
            {t('settings.prompt.import')}
          </button>
          <button className={styles.addButton} onClick={onAdd}>
            <span className="codicon codicon-add" />
            {t('settings.prompt.create')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.loadingState}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.prompt.loading')}</span>
        </div>
      ) : prompts.length === 0 ? (
        <div className={styles.emptyState}>
          <span>{t('settings.prompt.noPrompts')}</span>
          <button className={styles.createLink} onClick={onAdd}>
            {t('settings.prompt.create')}
          </button>
        </div>
      ) : (
        <div className={styles.promptList}>
          {prompts.map((prompt) => (
            <div key={prompt.id} className={styles.promptCard}>
              <div className={styles.promptIcon}>
                <span className="codicon codicon-bookmark" />
              </div>
              <div className={styles.promptInfo}>
                <div className={styles.promptName}>{prompt.name}</div>
                {prompt.content && (
                  <div className={styles.promptContent} title={prompt.content}>
                    {prompt.content.length > 80
                      ? prompt.content.substring(0, 80) + '...'
                      : prompt.content}
                  </div>
                )}
              </div>
              <div className={styles.promptActions} ref={openMenuId === prompt.id ? menuRef : null}>
                <button
                  className={styles.menuButton}
                  onClick={() => handleMenuToggle(prompt.id)}
                  title={t('settings.prompt.menu')}
                >
                  <span className="codicon codicon-kebab-vertical" />
                </button>
                {openMenuId === prompt.id && (
                  <div className={styles.dropdownMenu}>
                    <button
                      className={styles.menuItem}
                      onClick={() => handleEditClick(prompt)}
                    >
                      <span className="codicon codicon-edit" />
                      {t('common.edit')}
                    </button>
                    {showCopyToGlobal && (
                      <button
                        className={styles.menuItem}
                        onClick={() => handleCopyClick(prompt)}
                      >
                        <span className="codicon codicon-arrow-up" />
                        {t('settings.prompt.copyToGlobal')}
                      </button>
                    )}
                    <button
                      className={`${styles.menuItem} ${styles.danger}`}
                      onClick={() => handleDeleteClick(prompt)}
                    >
                      <span className="codicon codicon-trash" />
                      {t('common.delete')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Create styles**

```less
// webview/src/components/settings/PromptSection/PromptScopeSection.module.less
.scopeSection {
  margin-bottom: 24px;

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;

    .title {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .actions {
      display: flex;
      gap: 8px;
    }

    .actionButton {
      padding: 4px 12px;
      font-size: 12px;
      background: transparent;
      border: 1px solid var(--vscode-button-border);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      border-radius: 2px;

      &:hover {
        background: var(--vscode-button-hoverBackground);
      }

      .codicon {
        margin-right: 4px;
      }
    }

    .addButton {
      @extend .actionButton;
      background: var(--vscode-button-background);

      &:hover {
        background: var(--vscode-button-hoverBackground);
      }
    }
  }

  // Reuse existing styles from PromptSection
  .loadingState,
  .emptyState,
  .promptList,
  .promptCard,
  .promptIcon,
  .promptInfo,
  .promptName,
  .promptContent,
  .promptActions,
  .menuButton,
  .dropdownMenu,
  .menuItem {
    // Copy styles from ../PromptSection/style.module.less
  }
}
```

**Step 3: Commit**

```bash
git add webview/src/components/settings/PromptSection/PromptScopeSection.tsx webview/src/components/settings/PromptSection/PromptScopeSection.module.less
git commit -m "feat: add PromptScopeSection component

- Reusable component for displaying prompts in a scope
- Supports all CRUD operations
- Optional copy to global functionality
- Separate header with scope-specific actions"
```

---

### Task 11: Update Main PromptSection Component

**Files:**
- Modify: `webview/src/components/settings/PromptSection/index.tsx`

**Step 1: Refactor to use PromptScopeSection**

```typescript
// webview/src/components/settings/PromptSection/index.tsx
import { useTranslation } from 'react-i18next';
import type { PromptConfig, ProjectInfo } from '../../../types/prompt';
import type { PromptScope } from '../../../types/scope';
import PromptScopeSection from './PromptScopeSection';
import styles from './style.module.less';

interface PromptSectionProps {
  globalPrompts: PromptConfig[];
  projectPrompts: PromptConfig[];
  projectInfo: ProjectInfo | null;
  loading: boolean;
  onAdd: (scope: PromptScope) => void;
  onEdit: (prompt: PromptConfig, scope: PromptScope) => void;
  onDelete: (prompt: PromptConfig, scope: PromptScope) => void;
  onExport: (scope: PromptScope) => void;
  onImport: (scope: PromptScope) => void;
  onCopyToGlobal?: (prompt: PromptConfig) => void;
}

export default function PromptSection({
  globalPrompts,
  projectPrompts,
  projectInfo,
  loading,
  onAdd,
  onEdit,
  onDelete,
  onExport,
  onImport,
  onCopyToGlobal,
}: PromptSectionProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleWrapper}>
          <h3 className={styles.title}>{t('settings.prompt.title')}</h3>
        </div>
      </div>

      <div className={styles.description}>
        {t('settings.prompt.description')}
      </div>

      {/* Global Prompts Section */}
      <PromptScopeSection
        title={t('settings.prompt.global')}
        scope="global"
        prompts={globalPrompts}
        loading={loading}
        onAdd={() => onAdd('global')}
        onEdit={(prompt) => onEdit(prompt, 'global')}
        onDelete={(prompt) => onDelete(prompt, 'global')}
        onExport={() => onExport('global')}
        onImport={() => onImport('global')}
      />

      {/* Project Prompts Section */}
      {projectInfo?.available ? (
        <PromptScopeSection
          title={t('settings.prompt.projectScope', { projectName: projectInfo.name || 'Unknown' })}
          scope="project"
          prompts={projectPrompts}
          loading={loading}
          showCopyToGlobal={true}
          onAdd={() => onAdd('project')}
          onEdit={(prompt) => onEdit(prompt, 'project')}
          onDelete={(prompt) => onDelete(prompt, 'project')}
          onExport={() => onExport('project')}
          onImport={() => onImport('project')}
          onCopyToGlobal={onCopyToGlobal}
        />
      ) : (
        <div className={styles.noProjectSection}>
          <h4 className={styles.sectionTitle}>{t('settings.prompt.project')}</h4>
          <div className={styles.emptyState}>
            <span>{t('settings.prompt.noProject')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Update styles**

```less
// Add to webview/src/components/settings/PromptSection/style.module.less
.noProjectSection {
  margin-top: 24px;

  .sectionTitle {
    margin: 0 0 16px 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-foreground);
  }

  .emptyState {
    padding: 32px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
  }
}
```

**Step 3: Commit**

```bash
git add webview/src/components/settings/PromptSection/index.tsx webview/src/components/settings/PromptSection/style.module.less
git commit -m "refactor: update PromptSection to support dual scopes

- Use PromptScopeSection for global and project prompts
- Show project section only when project is available
- Pass scope to all handlers
- Support copy to global for project prompts"
```

---

### Task 12: Update Settings Page to Wire Everything

**Files:**
- Modify: `webview/src/pages/Settings/index.tsx`

**Step 1: Update Settings page to use new props**

```typescript
// In Settings page component:
const {
  prompts: globalPrompts,
  projectPrompts,
  projectInfo,
  promptsLoading,
  promptDialog,
  deletePromptConfirm,
  importPreviewDialog,
  exportDialog,
  loadPrompts,
  updatePrompts,
  updateProjectInfo,
  // ... other methods
  handleCopyToGlobal,
} = usePromptManagement({ onSuccess, onError });

// Setup window callbacks:
useEffect(() => {
  window.updatePrompts = (scope: string, promptsJson: string) => {
    try {
      const promptsList = JSON.parse(promptsJson);
      updatePrompts(scope as PromptScope, promptsList);
    } catch (error) {
      console.error('Failed to parse prompts:', error);
    }
  };

  window.updateProjectInfo = (infoJson: string) => {
    try {
      const info = JSON.parse(infoJson);
      updateProjectInfo(info);
    } catch (error) {
      console.error('Failed to parse project info:', error);
    }
  };

  // ... existing callbacks

  return () => {
    delete window.updatePrompts;
    delete window.updateProjectInfo;
  };
}, [updatePrompts, updateProjectInfo]);

// Pass to PromptSection:
<PromptSection
  globalPrompts={globalPrompts}
  projectPrompts={projectPrompts}
  projectInfo={projectInfo}
  loading={promptsLoading}
  onAdd={handleAddPrompt}
  onEdit={handleEditPrompt}
  onDelete={handleDeletePrompt}
  onExport={handleExportPrompts}
  onImport={handleImportPromptsFile}
  onCopyToGlobal={handleCopyToGlobal}
/>
```

**Step 2: Commit**

```bash
git add webview/src/pages/Settings/index.tsx
git commit -m "feat: wire up dual-scope prompts in Settings page

- Add window callbacks for scope-aware updates
- Pass project info to PromptSection
- Support copy to global functionality
- Update all handlers to include scope"
```

---

### Task 13: Add Internationalization

**Files:**
- Modify: `webview/src/locales/zh/translation.json`
- Modify: `webview/src/locales/en/translation.json`

**Step 1: Add Chinese translations**

```json
{
  "settings": {
    "prompt": {
      "global": "全局提示词",
      "project": "项目提示词",
      "projectScope": "项目提示词 - {{projectName}}",
      "copyToGlobal": "复制到全局",
      "noProject": "无活动项目",
      "scopeLabel": {
        "global": "全局",
        "project": "项目"
      }
    }
  }
}
```

**Step 2: Add English translations**

```json
{
  "settings": {
    "prompt": {
      "global": "Global Prompts",
      "project": "Project Prompts",
      "projectScope": "Project Prompts - {{projectName}}",
      "copyToGlobal": "Copy to Global",
      "noProject": "No Active Project",
      "scopeLabel": {
        "global": "Global",
        "project": "Project"
      }
    }
  }
}
```

**Step 3: Commit**

```bash
git add webview/src/locales/zh/translation.json webview/src/locales/en/translation.json
git commit -m "i18n: add translations for project-level prompts

- Add scope-specific labels
- Add copy to global action text
- Support both Chinese and English"
```

---

### Task 14: Update promptProvider for Chat Integration

**Files:**
- Modify: `webview/src/components/ChatInputBox/providers/promptProvider.ts`

**Step 1: Update to fetch from both scopes**

```typescript
// webview/src/components/ChatInputBox/providers/promptProvider.ts
async fetchPrompts(): Promise<PromptItem[]> {
  const CACHE_DURATION = 2000;
  const now = Date.now();

  if (this.cachedPrompts && now - this.lastFetchTime < CACHE_DURATION) {
    return this.cachedPrompts;
  }

  return new Promise((resolve) => {
    const TIMEOUT = 1500;
    let resolved = false;

    const globalPrompts: PromptConfig[] = [];
    const projectPrompts: PromptConfig[] = [];
    let receivedGlobal = false;
    let receivedProject = false;

    const tryResolve = () => {
      if (receivedGlobal && receivedProject && !resolved) {
        resolved = true;

        // Merge prompts with scope labels
        const allPrompts: PromptItem[] = [
          ...projectPrompts.map(p => ({ ...p, scope: 'project' as const })),
          ...globalPrompts.map(p => ({ ...p, scope: 'global' as const })),
        ];

        this.cachedPrompts = allPrompts;
        this.lastFetchTime = Date.now();
        resolve(allPrompts);
      }
    };

    // Setup temporary callbacks
    const originalUpdatePrompts = window.updatePrompts;

    window.updatePrompts = (scope: string, promptsJson: string) => {
      try {
        const prompts = JSON.parse(promptsJson);

        if (scope === 'global') {
          globalPrompts.push(...prompts);
          receivedGlobal = true;
        } else if (scope === 'project') {
          projectPrompts.push(...prompts);
          receivedProject = true;
        }

        tryResolve();
      } catch (error) {
        console.error('Failed to parse prompts:', error);
      }

      // Call original callback if exists
      originalUpdatePrompts?.(scope, promptsJson);
    };

    // Request both scopes
    sendToJava('get_prompts:' + JSON.stringify({ scope: 'global' }));
    sendToJava('get_prompts:' + JSON.stringify({ scope: 'project' }));

    // Timeout fallback
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        window.updatePrompts = originalUpdatePrompts;

        const allPrompts: PromptItem[] = [
          ...projectPrompts.map(p => ({ ...p, scope: 'project' as const })),
          ...globalPrompts.map(p => ({ ...p, scope: 'global' as const })),
        ];

        this.cachedPrompts = allPrompts;
        this.lastFetchTime = Date.now();
        resolve(allPrompts);
      }
    }, TIMEOUT);
  });
}

// Update formatPromptLabel to show scope:
formatPromptLabel(prompt: PromptItem): string {
  const scopeLabel = prompt.scope === 'project' ?
    t('settings.prompt.scopeLabel.project') :
    t('settings.prompt.scopeLabel.global');
  return `${prompt.name} [${scopeLabel}]`;
}
```

**Step 2: Commit**

```bash
git add webview/src/components/ChatInputBox/providers/promptProvider.ts
git commit -m "feat: update promptProvider for dual-scope prompts

- Fetch prompts from both global and project scopes
- Add scope labels to autocomplete items
- Prioritize project prompts in list
- Handle timeout gracefully"
```

---

## Phase 3: Testing and Verification

### Task 15: Manual Testing Checklist

**Files:**
- None (manual testing)

**Step 1: Test global prompts CRUD**

Manual test:
1. Open Settings page
2. Create a new global prompt
3. Edit the global prompt
4. Export global prompts
5. Delete the global prompt
6. Import global prompts

Expected: All operations work correctly

**Step 2: Test project prompts CRUD**

Manual test:
1. Open a project in IDE
2. Open Settings page
3. Create a new project prompt
4. Verify prompt saved in `.codemoss/prompt.json`
5. Edit the project prompt
6. Export project prompts
7. Delete the project prompt
8. Import project prompts

Expected: All operations work correctly, file appears in project directory

**Step 3: Test copy to global**

Manual test:
1. Create a project prompt
2. Click "Copy to Global"
3. Verify prompt appears in global section with new ID

Expected: Prompt copied successfully

**Step 4: Test chat autocomplete**

Manual test:
1. Create global and project prompts with different names
2. Open chat input
3. Type `!` to trigger autocomplete
4. Verify both global and project prompts appear with scope labels

Expected: Both scopes visible, project prompts appear first

**Step 5: Test no project scenario**

Manual test:
1. Close all projects
2. Open Settings page
3. Verify project section shows "No Active Project"
4. Verify global section still works

Expected: Graceful handling of missing project

**Step 6: Document test results**

Create: `docs/testing/project-prompts-manual-test.md`

```markdown
# Project-Level Prompts Manual Test Results

Date: [Date]
Tester: [Name]

## Test Results

### Global Prompts
- [ ] Create: PASS/FAIL
- [ ] Read: PASS/FAIL
- [ ] Update: PASS/FAIL
- [ ] Delete: PASS/FAIL
- [ ] Export: PASS/FAIL
- [ ] Import: PASS/FAIL

### Project Prompts
- [ ] Create: PASS/FAIL
- [ ] File location correct: PASS/FAIL
- [ ] Update: PASS/FAIL
- [ ] Delete: PASS/FAIL
- [ ] Export: PASS/FAIL
- [ ] Import: PASS/FAIL

### Copy to Global
- [ ] Copy operation: PASS/FAIL
- [ ] New ID generated: PASS/FAIL

### Chat Integration
- [ ] Autocomplete shows both scopes: PASS/FAIL
- [ ] Scope labels visible: PASS/FAIL
- [ ] Project prompts prioritized: PASS/FAIL

### Edge Cases
- [ ] No project scenario: PASS/FAIL
- [ ] Multiple projects: PASS/FAIL
- [ ] Large prompt files: PASS/FAIL

## Issues Found
[List any issues discovered]

## Notes
[Any additional observations]
```

**Step 7: Commit test documentation**

```bash
git add docs/testing/project-prompts-manual-test.md
git commit -m "docs: add manual testing checklist for project prompts"
```

---

## Phase 4: Documentation and Finalization

### Task 16: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

**Step 1: Add changelog entry**

```markdown
## [Unreleased]

### Added
- Project-level prompt storage in `.codemoss/prompt.json`
- Separate management UI for global and project prompts
- Copy project prompts to global scope
- Scope indicators in chat autocomplete
- Support for team sharing prompts via Git

### Changed
- Refactored `PromptManager` to abstract base class architecture
- Updated prompt handling to support dual scopes
- Enhanced Settings UI with separate sections for each scope

### Technical
- Added `PromptScope` enum (GLOBAL/PROJECT)
- Implemented `AbstractPromptManager`, `GlobalPromptManager`, `ProjectPromptManager`
- Added `PromptManagerFactory` for scope-based manager creation
- Extended frontend types for scope support
- Updated `PromptHandler` with new message types
```

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for project-level prompts feature"
```

---

### Task 17: Create Pull Request

**Files:**
- None (Git operation)

**Step 1: Push feature branch**

```bash
git push -u origin feature/project-level-prompts
```

**Step 2: Create PR using gh CLI**

```bash
gh pr create --title "feat: add project-level prompt storage" --body "$(cat <<'EOF'
## Summary

Adds project-level prompt storage alongside existing global prompts, enabling team collaboration through Git-tracked project-specific prompts.

## Key Changes

### Backend
- Refactored `PromptManager` to abstract base class
- Implemented `GlobalPromptManager` (uses `~/.codemoss/prompt.json`)
- Implemented `ProjectPromptManager` (uses `<project>/.codemoss/prompt.json`)
- Added `PromptScope` enum and `PromptManagerFactory`
- Updated `PromptHandler` with scope support and new operations

### Frontend
- Created `PromptScopeSection` reusable component
- Updated Settings UI with separate sections for global/project
- Enhanced chat autocomplete with scope labels
- Added copy to global functionality

### Features
- Independent CRUD operations for each scope
- Import/export per scope
- Project info display
- Graceful handling of no-project scenario
- Team sharing via Git (project prompts committed to repo)

## Testing

- [ ] All unit tests pass
- [ ] Manual testing completed (see docs/testing/project-prompts-manual-test.md)
- [ ] Global prompts work as before (backward compatible)
- [ ] Project prompts saved in correct location
- [ ] Chat autocomplete shows both scopes
- [ ] Copy to global works correctly
- [ ] No project scenario handled gracefully

## Test Plan

1. Create/edit/delete global prompts
2. Create/edit/delete project prompts
3. Export/import both scopes
4. Copy project prompt to global
5. Test chat autocomplete
6. Test with no active project
7. Verify `.codemoss/prompt.json` in project directory

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Expected:** PR created successfully with URL returned

**Step 3: Commit**

```bash
# No commit needed, PR creation is the final step
```

---

## Summary

This implementation plan provides step-by-step instructions for adding project-level prompt storage to the codebase. The plan follows TDD principles with tests written before implementation, frequent commits, and clear verification steps.

**Total Estimated Time:** 3-4 days

**Key Milestones:**
1. Backend architecture complete (Day 1-2)
2. Frontend integration complete (Day 2-3)
3. Testing and documentation (Day 3-4)

**Risk Mitigation:**
- Backward compatibility maintained through deprecated methods
- Extensive testing at each step
- Graceful error handling for edge cases
- Clear separation of concerns through abstract base class

**Next Steps After Merge:**
- Monitor for issues in production
- Gather user feedback
- Consider future enhancements (team-level, cloud sync)
