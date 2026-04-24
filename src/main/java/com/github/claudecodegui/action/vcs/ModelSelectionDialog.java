package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.ModelInfo;
import com.github.claudecodegui.provider.ModelListProvider;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.ProviderManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.ui.components.JBList;
import com.intellij.ui.components.JBTextField;
import com.google.gson.JsonObject;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;
import java.util.List;

/**
 * Dialog for selecting AI model for commit message generation.
 * Supports Claude models, Codex/GPT models, and custom model input.
 * Uses ModelListProvider to get the dynamic model list synchronized with frontend.
 */
public class ModelSelectionDialog extends DialogWrapper {

    private JBList<ModelInfo> modelList;
    private JBTextField customModelField;
    private JCheckBox customModelCheckBox;
    private final Project project;
    private final ModelListProvider modelListProvider;

    private String selectedModel;

    public ModelSelectionDialog(@Nullable Project project) {
        super(project, false);
        this.project = project;
        this.modelListProvider = new ModelListProvider();
        setTitle(ClaudeCodeGuiBundle.message("commit.modelSelection.title"));
        setModal(true);
        setResizable(false);

        // Get model list from provider
        List<ModelInfo> models = modelListProvider.getAllModels();
        modelList = new JBList<>(models);
        modelList.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        modelList.setSelectedIndex(0); // Default to first model
        modelList.setCellRenderer(new DefaultListCellRenderer() {
            @Override
            public Component getListCellRendererComponent(JList<?> list, Object value, int index,
                    boolean isSelected, boolean cellHasFocus) {
                Component c = super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus);
                if (value instanceof ModelInfo) {
                    ModelInfo model = (ModelInfo) value;
                    setText(model.toDisplayString());
                }
                return c;
            }
        });

        // Custom model field
        customModelField = new JBTextField();
        customModelField.setEnabled(false);
        customModelCheckBox = new JCheckBox("Use Custom Model:");
        customModelCheckBox.addActionListener(e -> {
            customModelField.setEnabled(customModelCheckBox.isSelected());
            if (customModelCheckBox.isSelected()) {
                modelList.clearSelection();
            } else {
                modelList.setSelectedIndex(0);
            }
        });

        init();
    }

    /**
     * Get SDK display information for the current provider.
     */
    private SdkDisplayInfo getSdkDisplayInfo() {
        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            JsonObject activeProvider = settingsService.getActiveClaudeProvider();

            if (activeProvider == null) {
                return getDefaultSdkInfo();
            }

            String providerId = activeProvider.has("id") ? activeProvider.get("id").getAsString() : "";
            boolean isLocalProvider = "__local_settings_json__".equals(providerId);
            boolean isCliLoginProvider = "__cli_login__".equals(providerId);

            // Check for Bedrock
            JsonObject settingsConfig = activeProvider.has("settingsConfig") ?
                activeProvider.getAsJsonObject("settingsConfig") : null;
            boolean useBedrock = false;
            String baseUrl = null;

            if (settingsConfig != null && settingsConfig.has("env")) {
                JsonObject env = settingsConfig.getAsJsonObject("env");
                useBedrock = env.has("CLAUDE_CODE_USE_BEDROCK") &&
                    ("1".equals(env.get("CLAUDE_CODE_USE_BEDROCK").getAsString()) ||
                     "true".equals(env.get("CLAUDE_CODE_USE_BEDROCK").getAsString()));
                baseUrl = env.has("ANTHROPIC_BASE_URL") ?
                    env.get("ANTHROPIC_BASE_URL").getAsString() : null;
            }

            // Determine SDK info
            if (isCliLoginProvider) {
                return new SdkDisplayInfo(
                    "Claude Agent SDK",
                    "OAuth (CLI Login)",
                    "SDK: @anthropic-ai/claude-agent-sdk → OAuth (CLI Login)"
                );
            }

            if (useBedrock) {
                return new SdkDisplayInfo(
                    "Bedrock SDK",
                    "AWS Bedrock",
                    "SDK: @anthropic-ai/bedrock-sdk → AWS Bedrock"
                );
            }

            if (baseUrl != null && !baseUrl.isEmpty() && isCustomBaseUrl(baseUrl)) {
                String host = extractHost(baseUrl);
                return new SdkDisplayInfo(
                    "Anthropic SDK",
                    host,
                    "SDK: @anthropic-ai/sdk → " + host
                );
            }

            return getDefaultSdkInfo();

        } catch (Exception e) {
            return getDefaultSdkInfo();
        }
    }

    /**
     * Get default SDK info (official Anthropic API).
     */
    private SdkDisplayInfo getDefaultSdkInfo() {
        return new SdkDisplayInfo(
            "Claude Agent SDK",
            "api.anthropic.com",
            "SDK: @anthropic-ai/claude-agent-sdk → api.anthropic.com"
        );
    }

    /**
     * Check if a base URL is custom (non-official Anthropic API).
     */
    private boolean isCustomBaseUrl(String baseUrl) {
        if (baseUrl == null || baseUrl.isEmpty()) {
            return false;
        }
        String lowerUrl = baseUrl.toLowerCase();
        return !lowerUrl.contains("api.anthropic.com");
    }

    /**
     * Extract host from URL.
     */
    private String extractHost(String url) {
        try {
            if (url.startsWith("http://") || url.startsWith("https://")) {
                java.net.URL urlObj = new java.net.URL(url);
                return urlObj.getHost();
            }
            return url.replaceFirst("^https?://", "").replaceFirst("/.*$", "").replaceFirst("/$", "");
        } catch (Exception e) {
            return url.replaceFirst("^https?://", "").replaceFirst("/.*$", "").replaceFirst("/$", "");
        }
    }

    /**
     * SDK display information.
     */
    private static class SdkDisplayInfo {
        final String sdkName;
        final String targetAddress;
        final String description;

        SdkDisplayInfo(String sdkName, String targetAddress, String description) {
            this.sdkName = sdkName;
            this.targetAddress = targetAddress;
            this.description = description;
        }
    }

    @Override
    protected @Nullable JComponent createCenterPanel() {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setPreferredSize(new Dimension(450, 350));

        // Title label
        JLabel label = new JLabel(ClaudeCodeGuiBundle.message("commit.modelSelection.label"));
        label.setBorder(BorderFactory.createEmptyBorder(10, 10, 5, 10));
        panel.add(label, BorderLayout.NORTH);

        // Main content panel
        JPanel mainPanel = new JPanel(new BorderLayout());

        // SDK Info Panel (top)
        SdkDisplayInfo sdkInfo = getSdkDisplayInfo();
        JPanel sdkInfoPanel = createSdkInfoPanel(sdkInfo);
        mainPanel.add(sdkInfoPanel, BorderLayout.NORTH);

        // Model list
        JPanel listPanel = new JPanel(new BorderLayout());
        JScrollPane scrollPane = new JScrollPane(modelList);
        scrollPane.setBorder(BorderFactory.createEmptyBorder(5, 10, 10, 10));
        listPanel.add(scrollPane, BorderLayout.CENTER);

        mainPanel.add(listPanel, BorderLayout.CENTER);

        panel.add(mainPanel, BorderLayout.CENTER);

        // Custom model panel
        JPanel customPanel = new JPanel(new BorderLayout(10, 0));
        customPanel.setBorder(BorderFactory.createEmptyBorder(5, 10, 10, 10));
        customPanel.add(customModelCheckBox, BorderLayout.WEST);
        customPanel.add(customModelField, BorderLayout.CENTER);

        panel.add(customPanel, BorderLayout.SOUTH);

        return panel;
    }

    /**
     * Create SDK info panel.
     */
    private JPanel createSdkInfoPanel(SdkDisplayInfo sdkInfo) {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setBorder(BorderFactory.createCompoundBorder(
            BorderFactory.createEmptyBorder(5, 10, 5, 10),
            BorderFactory.createLineBorder(UIManager.getColor("Component.border"))
        ));
        panel.setBackground(UIManager.getColor("Panel.background"));

        // SDK info label with icon-like appearance
        JLabel sdkLabel = new JLabel("<html><b>Current SDK:</b> " + sdkInfo.description + "</html>");
        sdkLabel.setBorder(BorderFactory.createEmptyBorder(5, 10, 5, 10));
        panel.add(sdkLabel, BorderLayout.CENTER);

        return panel;
    }

    @Override
    protected @NotNull Action[] createActions() {
        return new Action[]{getOKAction(), getCancelAction()};
    }

    @Override
    protected void doOKAction() {
        // Check if custom model is selected
        if (customModelCheckBox.isSelected()) {
            String customModel = customModelField.getText().trim();
            if (!customModel.isEmpty()) {
                selectedModel = customModel;
            } else {
                // Fallback to first model if custom field is empty
                selectedModel = modelListProvider.getDefaultModelId();
            }
        } else {
            // Use selected model from list
            ModelInfo selected = modelList.getSelectedValue();
            if (selected != null) {
                selectedModel = selected.getId();
            } else {
                selectedModel = modelListProvider.getDefaultModelId(); // Fallback to default
            }
        }
        super.doOKAction();
    }

    public String getSelectedModel() {
        return selectedModel;
    }
}
