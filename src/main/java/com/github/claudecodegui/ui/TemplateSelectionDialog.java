package com.github.claudecodegui.ui;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.SessionTemplate;
import com.github.claudecodegui.settings.SessionTemplateService;
import com.intellij.openapi.util.text.StringUtil;
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
                    setText(template.getName());
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
        tooltip.append("<b>").append(escapeTooltipValue(template.getName())).append("</b><br>");
        tooltip.append("Provider: ").append(escapeTooltipValue(template.getProvider())).append("<br>");
        tooltip.append("Model: ").append(escapeTooltipValue(template.getModel())).append("<br>");
        if (template.getCwd() != null && !template.getCwd().isEmpty()) {
            tooltip.append("Working Directory: ").append(escapeTooltipValue(template.getCwd())).append("<br>");
        }
        tooltip.append("</html>");
        return tooltip.toString();
    }

    private String escapeTooltipValue(String value) {
        return StringUtil.escapeXmlEntities(value != null ? value : "");
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
