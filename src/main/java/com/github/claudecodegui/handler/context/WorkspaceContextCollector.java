package com.github.claudecodegui.handler.context;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.module.ModuleUtilCore;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.reflect.Method;
import java.util.Collection;

/**
 * Workspace context collector for multi-project workspace support.
 * Dynamically detects and reads workspace plugin data to provide
 * multi-directory/maven module information for AI context.
 */
public class WorkspaceContextCollector {

    private static final Logger LOG = Logger.getInstance(WorkspaceContextCollector.class);

    private static final boolean WORKSPACE_PLUGIN_AVAILABLE = isWorkspacePluginAvailable();
    private static Method getSubprojectManagerMethod;
    private static Method getAllSubprojectsMethod;
    private static Method getSubprojectPathMethod;
    private static Method getSubprojectNameMethod;
    private static Method getSubprojectByPathMethod;
    private static Method getHandlerMethod;
    private static volatile Method isLoadedMethod;
    private static Class<?> subprojectClass;

    static {
        if (WORKSPACE_PLUGIN_AVAILABLE) {
            try {
                Class<?> subprojectManagerClass = Class.forName(
                    "com.intellij.ide.workspace.SubprojectManager");
                Class<?> subprojectManagerKtClass = Class.forName(
                    "com.intellij.ide.workspace.SubprojectManagerKt");
                subprojectClass = Class.forName(
                    "com.intellij.ide.workspace.Subproject");

                getSubprojectManagerMethod = subprojectManagerKtClass.getMethod(
                    "getSubprojectManager", Project.class);

                getAllSubprojectsMethod = subprojectManagerClass.getMethod(
                    "getAllSubprojects");

                getSubprojectPathMethod = subprojectClass.getMethod("getProjectPath");
                getSubprojectNameMethod = subprojectClass.getMethod("getName");

                getHandlerMethod = subprojectClass.getMethod("getHandler");

                getSubprojectByPathMethod = subprojectManagerClass.getMethod(
                    "getSubprojectByPath", String.class, boolean.class);

                LOG.info("Workspace plugin detected - multi-project context collection enabled");
            } catch (Exception e) {
                LOG.warn("Failed to load workspace plugin classes: " + e.getMessage());
            }
        }
    }

    private static boolean isWorkspacePluginAvailable() {
        try {
            Class.forName("com.intellij.ide.workspace.SubprojectManager");
            Class.forName("com.intellij.ide.workspace.WorkspaceSettings");
            return true;
        } catch (ClassNotFoundException e) {
            LOG.info("Workspace plugin not available - standard single-project mode");
            return false;
        }
    }

    /**
     * Collect workspace context information for the given project.
     *
     * @param project The current project.
     * @return JsonObject containing workspace information including subprojects.
     */
    public static @NotNull JsonObject collectWorkspaceContext(@Nullable Project project) {
        JsonObject workspaceData = new JsonObject();

        if (project == null) {
            return workspaceData;
        }

        try {
            // 1. Check if this is a multi-project workspace
            boolean isWorkspace = checkIsWorkspace(project);
            workspaceData.addProperty("isWorkspace", isWorkspace);

            if (!isWorkspace) {
                // If not a workspace, still collect module info for single project
                collectModuleInfo(project, workspaceData);
                return workspaceData;
            }

            // 2. Collect subprojects from workspace plugin
            JsonArray subprojects = collectSubprojects(project);
            workspaceData.add("subprojects", subprojects);
            if (subprojects.size() > 0) {
                LOG.debug("Collected " + subprojects.size() + " subprojects from workspace");
            } else {
                LOG.debug("No subprojects collected from workspace plugin");
            }

            // 3. Collect module information (may overlap with subprojects but provides more details)
            collectModuleInfo(project, workspaceData);

            // 4. Determine which subproject the active file belongs to
            String projectBasePath = project.getBasePath();
            if (projectBasePath != null) {
                workspaceData.addProperty("workspaceRoot", projectBasePath);
            }

        } catch (Throwable t) {
            LOG.warn("Failed to collect workspace context: " + t.getMessage(), t);
        }

        return workspaceData;
    }

    /**
     * Check if the project is a multi-project workspace.
     */
    private static boolean checkIsWorkspace(@NotNull Project project) {
        if (!WORKSPACE_PLUGIN_AVAILABLE || getSubprojectManagerMethod == null) {
            return false;
        }

        try {
            Object manager = getSubprojectManagerMethod.invoke(null, project);
            if (manager == null) {
                return false;
            }

            Class<?> workspaceSettingsClass = Class.forName(
                "com.intellij.ide.workspace.WorkspaceSettings");
            Method getServiceMethod = workspaceSettingsClass.getMethod("getInstance", Project.class);
            Object settings = getServiceMethod.invoke(null, project);

            if (settings != null) {
                Method isWorkspaceMethod = workspaceSettingsClass.getMethod("isWorkspace");
                return Boolean.TRUE.equals(isWorkspaceMethod.invoke(settings));
            }
        } catch (Exception e) {
            LOG.debug("Failed to check isWorkspace: " + e.getMessage());
        }

        return false;
    }

    /**
     * Collect subprojects from workspace plugin using reflection.
     */
    private static @NotNull JsonArray collectSubprojects(@NotNull Project project) {
        JsonArray subprojectsArray = new JsonArray();

        if (!WORKSPACE_PLUGIN_AVAILABLE || getSubprojectManagerMethod == null
                || getAllSubprojectsMethod == null || subprojectClass == null) {
            return subprojectsArray;
        }

        try {
            Object manager = getSubprojectManagerMethod.invoke(null, project);
            if (manager == null) {
                return subprojectsArray;
            }

            Object subprojectsCollection = getAllSubprojectsMethod.invoke(manager);
            if (!(subprojectsCollection instanceof Collection)) {
                return subprojectsArray;
            }

            for (Object subproject : (Collection<?>) subprojectsCollection) {
                if (subprojectClass.isInstance(subproject)) {
                    JsonObject subprojectJson = new JsonObject();

                    String name = (String) getSubprojectNameMethod.invoke(subproject);
                    String path = (String) getSubprojectPathMethod.invoke(subproject);

                    if (name != null && path != null) {
                        subprojectJson.addProperty("name", name);
                        subprojectJson.addProperty("path", path);

                        String handlerType = getHandlerType(subproject);
                        if (handlerType != null) {
                            subprojectJson.addProperty("type", handlerType);
                        }

                        boolean isLoaded = checkSubprojectLoaded(subproject);
                        subprojectJson.addProperty("loaded", isLoaded);

                        subprojectsArray.add(subprojectJson);
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to collect subprojects: " + e.getMessage());
        }

        return subprojectsArray;
    }

    /**
     * Get the handler type for a subproject (Gradle, Maven, etc).
     */
    private static @Nullable String getHandlerType(@NotNull Object subproject) {
        if (getHandlerMethod == null) {
            return null;
        }

        try {
            Object handler = getHandlerMethod.invoke(subproject);

            if (handler != null) {
                String handlerClassName = handler.getClass().getSimpleName();
                if (handlerClassName.contains("Gradle")) {
                    return "Gradle";
                } else if (handlerClassName.contains("Maven")) {
                    return "Maven";
                } else if (handlerClassName.contains("Default")) {
                    return "Default";
                }
                return handlerClassName.replace("SubprojectHandler", "");
            }
        } catch (Exception e) {
            LOG.debug("Failed to get handler type: " + e.getMessage());
        }
        return null;
    }

    /**
     * Check if a subproject is loaded.
     */
    private static boolean checkSubprojectLoaded(@NotNull Object subproject) {
        if (getHandlerMethod == null) {
            return true;
        }

        try {
            Object handler = getHandlerMethod.invoke(subproject);

            if (handler != null) {
                if (isLoadedMethod == null) {
                    isLoadedMethod = handler.getClass().getMethod("isLoaded", subprojectClass);
                }
                return Boolean.TRUE.equals(isLoadedMethod.invoke(handler, subproject));
            }
        } catch (Exception e) {
            LOG.debug("Failed to check subproject loaded status: " + e.getMessage());
        }
        return true; // Assume loaded if we can't check
    }

    /**
     * Collect module information from the project.
     * This works even without workspace plugin.
     */
    private static void collectModuleInfo(@NotNull Project project, @NotNull JsonObject workspaceData) {
        try {
            Module[] modules = ModuleManager.getInstance(project).getModules();
            JsonArray modulesArray = new JsonArray();

            for (Module module : modules) {
                JsonObject moduleJson = new JsonObject();
                moduleJson.addProperty("name", module.getName());

                VirtualFile[] contentRoots = ModuleRootManager.getInstance(module).getContentRoots();
                if (contentRoots.length > 0) {
                    JsonArray rootsArray = new JsonArray();
                    for (VirtualFile root : contentRoots) {
                        rootsArray.add(root.getPath());
                    }
                    moduleJson.add("contentRoots", rootsArray);
                }

                String moduleTypeName = getModuleTypeName(module);
                if (moduleTypeName != null) {
                    moduleJson.addProperty("type", moduleTypeName);
                }

                modulesArray.add(moduleJson);
            }

            if (modulesArray.size() > 0) {
                workspaceData.add("modules", modulesArray);
                LOG.debug("Collected " + modulesArray.size() + " modules");
            }
        } catch (Exception e) {
            LOG.warn("Failed to collect module info: " + e.getMessage());
        }
    }

    /**
     * Get module type name.
     * Returns the module type identifier if set (non-standard module types like Maven, Gradle).
     * Standard JAVA_MODULE types typically do not have this option set.
     */
    private static @Nullable String getModuleTypeName(@NotNull Module module) {
        String moduleType = module.getOptionValue("moduleType");
        return moduleType != null && !moduleType.isEmpty() ? moduleType : null;
    }

    /**
     * Determine which subproject a file belongs to.
     *
     * @param project The project.
     * @param filePath The file path to check.
     * @return The subproject name if found, null otherwise.
     */
    public static @Nullable String getSubprojectForFile(@Nullable Project project, @Nullable String filePath) {
        if (project == null || filePath == null) {
            return null;
        }

        // 1. Try using platform's SubprojectInfoProvider if available
        String subprojectPath = getSubprojectPathFromProvider(project, filePath);
        if (subprojectPath != null) {
            return extractSubprojectNameFromPath(subprojectPath);
        }

        // 2. Try using workspace plugin's SubprojectManager
        if (WORKSPACE_PLUGIN_AVAILABLE && getSubprojectManagerMethod != null
                && getSubprojectByPathMethod != null) {
            try {
                Object manager = getSubprojectManagerMethod.invoke(null, project);
                if (manager != null) {
                    Object subproject = getSubprojectByPathMethod.invoke(manager, filePath, false);

                    if (subproject != null && subprojectClass.isInstance(subproject)) {
                        return (String) getSubprojectNameMethod.invoke(subproject);
                    }
                }
            } catch (Exception e) {
                LOG.debug("Failed to get subproject for file via workspace plugin: " + e.getMessage());
            }
        }

        // 3. Fallback: find module containing the file
        return getModuleForFile(project, filePath);
    }

    /**
     * Get subproject path using platform's SubprojectInfoProvider (if available).
     * This class may not be available in all IntelliJ versions, so we use reflection.
     */
    private static @Nullable String getSubprojectPathFromProvider(@NotNull Project project, @NotNull String filePath) {
        try {
            Class<?> subprojectInfoProviderClass = Class.forName(
                "com.intellij.openapi.project.workspace.SubprojectInfoProvider");
            Method getServiceMethod = subprojectInfoProviderClass.getMethod("getInstance", Project.class);
            Object provider = getServiceMethod.invoke(null, project);

            if (provider != null) {
                VirtualFile file = LocalFileSystem.getInstance().findFileByPath(filePath);
                if (file != null) {
                    Method getPathMethod = subprojectInfoProviderClass.getMethod(
                        "getSubprojectPath", Project.class, VirtualFile.class);
                    return (String) getPathMethod.invoke(provider, project, file);
                }
            }
        } catch (ClassNotFoundException e) {
            LOG.debug("SubprojectInfoProvider not available: " + e.getMessage());
        } catch (Exception e) {
            LOG.debug("Failed to get subproject path from provider: " + e.getMessage());
        }
        return null;
    }

    /**
     * Extract subproject name from path.
     */
    private static @Nullable String extractSubprojectNameFromPath(@NotNull String path) {
        String trimmed = path.endsWith("/") ? path.substring(0, path.length() - 1) : path;
        int lastSlash = trimmed.lastIndexOf('/');
        if (lastSlash >= 0 && lastSlash < trimmed.length() - 1) {
            return trimmed.substring(lastSlash + 1);
        }
        return trimmed;
    }

    /**
     * Get the module name for a file.
     */
    private static @Nullable String getModuleForFile(@NotNull Project project, @NotNull String filePath) {
        try {
            VirtualFile file = LocalFileSystem.getInstance().findFileByPath(filePath);
            if (file != null) {
                Module module = ModuleUtilCore.findModuleForFile(file, project);
                if (module != null) {
                    return module.getName();
                }
            }
        } catch (Exception e) {
            LOG.debug("Failed to get module for file: " + e.getMessage());
        }
        return null;
    }
}
