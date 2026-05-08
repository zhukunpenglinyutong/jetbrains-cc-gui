package com.github.claudecodegui.ui;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.SessionTemplate;
import com.github.claudecodegui.settings.SessionTemplateService;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.ui.components.JBList;
import com.intellij.ui.components.JBScrollPane;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.List;

/**
 * Dialog for selecting a session template.
 */
public class TemplateSelectionDialog extends DialogWrapper {

    private final JBList<SessionTemplate> templateList;
    private final DefaultListModel<SessionTemplate> listModel;

    public TemplateSelectionDialog() {
        super(true);
        setTitle(ClaudeCodeGuiBundle.message("template.select.title"));
        setOKButtonText(ClaudeCodeGuiBundle.message("template.select.ok"));
        setCancelButtonText(ClaudeCodeGuiBundle.message("template.select.cancel"));

        listModel = new DefaultListModel<>();
        templateList = new JBList<>(listModel);

        // Load templates
        SessionTemplateService templateService = SessionTemplateService.getInstance();
        List<SessionTemplate> templates = templateService.getAllTemplates();
        for (SessionTemplate template : templates) {
            listModel.addElement(template);
        }

        // Set renderer for better display
        templateList.setCellRenderer(new DefaultListCellRenderer() {
            @Override
            public Component getListCellRendererComponent(JList<?> list, Object value, int index,
                                                        boolean isSelected, boolean cellHasFocus) {
                super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus);
                if (value instanceof SessionTemplate) {
                    SessionTemplate template = (SessionTemplate) value;
                    setText(template.name);
                    setToolTipText(buildTooltipText(template));
                }
                return this;
            }
        });

        // Double-click to select
        templateList.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2 && templateList.getSelectedValue() != null) {
                    doOKAction();
                }
            }
        });

        init();
    }

    private String buildTooltipText(SessionTemplate template) {
        StringBuilder tooltip = new StringBuilder();
        tooltip.append("<html>");
        tooltip.append("<b>").append(template.name).append("</b><br>");
        tooltip.append("Provider: ").append(template.provider).append("<br>");
        tooltip.append("Model: ").append(template.model).append("<br>");
        if (template.cwd != null && !template.cwd.isEmpty()) {
            tooltip.append("Working Directory: ").append(template.cwd).append("<br>");
        }
        tooltip.append("</html>");
        return tooltip.toString();
    }

    @Override
    protected @Nullable JComponent createCenterPanel() {
        JPanel panel = new JPanel(new BorderLayout());

        if (listModel.isEmpty()) {
            JLabel emptyLabel = new JLabel(ClaudeCodeGuiBundle.message("template.select.empty"));
            emptyLabel.setHorizontalAlignment(SwingConstants.CENTER);
            panel.add(emptyLabel, BorderLayout.CENTER);
        } else {
            JBScrollPane scrollPane = new JBScrollPane(templateList);
            scrollPane.setPreferredSize(new Dimension(300, 200));
            panel.add(scrollPane, BorderLayout.CENTER);
        }

        return panel;
    }

    /**
     * Get the selected template.
     */
    public SessionTemplate getSelectedTemplate() {
        return templateList.getSelectedValue();
    }

    @Override
    protected void doOKAction() {
        if (templateList.getSelectedValue() == null && !listModel.isEmpty()) {
            // Select first item if none selected
            templateList.setSelectedIndex(0);
        }
        super.doOKAction();
    }
}