package com.github.claudecodegui.ui;

import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.awt.*;
import java.util.function.Consumer;

/**
 * 错误面板构建器
 * 用于构建环境检查失败等错误提示面板
 */
public class ErrorPanelBuilder {

    private static final Logger LOG = Logger.getInstance(ErrorPanelBuilder.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    /**
     * 构建错误面板
     * @param title 标题
     * @param message 错误消息
     * @param currentNodePath 当前检测到的 Node.js 路径
     * @param onSaveAndRetry 保存并重试回调（参数为用户输入的路径，可能为 null 或空）
     * @return 错误面板
     */
    public static JPanel build(String title, String message, String currentNodePath, Consumer<String> onSaveAndRetry) {
        JPanel errorPanel = new JPanel(new BorderLayout());
        errorPanel.setBackground(new Color(30, 30, 30));

        // 标题
        JLabel titleLabel = new JLabel(title);
        titleLabel.setFont(new Font("SansSerif", Font.BOLD, 16));
        titleLabel.setForeground(Color.WHITE);
        titleLabel.setBorder(BorderFactory.createEmptyBorder(20, 20, 10, 20));

        // 错误消息区域
        JTextArea textArea = new JTextArea(message);
        textArea.setEditable(false);
        textArea.setFont(new Font("Monospaced", Font.PLAIN, 12));
        textArea.setBackground(new Color(40, 40, 40));
        textArea.setForeground(new Color(220, 220, 220));
        textArea.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
        textArea.setLineWrap(true);
        textArea.setWrapStyleWord(true);

        errorPanel.add(titleLabel, BorderLayout.NORTH);
        errorPanel.add(new JScrollPane(textArea), BorderLayout.CENTER);

        // 底部：手动指定 Node.js 路径
        JPanel bottomPanel = new JPanel();
        bottomPanel.setLayout(new BoxLayout(bottomPanel, BoxLayout.Y_AXIS));
        bottomPanel.setBorder(BorderFactory.createEmptyBorder(10, 20, 20, 20));
        bottomPanel.setBackground(new Color(30, 30, 30));

        JLabel nodeLabel = new JLabel("Node.js 路径（注意：保存后需手动重启IDE）:");
        nodeLabel.setForeground(Color.WHITE);
        nodeLabel.setAlignmentX(Component.LEFT_ALIGNMENT);

        JTextField nodeField = new JTextField();
        nodeField.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        nodeField.setAlignmentX(Component.LEFT_ALIGNMENT);

        // 预填充已保存的路径或当前检测到的路径
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);
            if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                nodeField.setText(savedNodePath.trim());
            } else if (currentNodePath != null) {
                nodeField.setText(currentNodePath);
            }
        } catch (Exception e) {
            LOG.warn("Failed to preload Node.js path: " + e.getMessage());
        }

        JButton saveAndRetryButton = new JButton("保存");
        saveAndRetryButton.setAlignmentX(Component.LEFT_ALIGNMENT);
        saveAndRetryButton.addActionListener(e -> {
            String manualPath = nodeField.getText();
            if (manualPath != null) {
                manualPath = manualPath.trim();
            }
            if (manualPath != null && manualPath.isEmpty()) {
                manualPath = null;
            }
            onSaveAndRetry.accept(manualPath);
        });

        bottomPanel.add(nodeLabel);
        bottomPanel.add(Box.createRigidArea(new Dimension(0, 5)));
        bottomPanel.add(nodeField);
        bottomPanel.add(Box.createRigidArea(new Dimension(0, 10)));
        bottomPanel.add(saveAndRetryButton);

        errorPanel.add(bottomPanel, BorderLayout.SOUTH);

        return errorPanel;
    }

    /**
     * 构建简单错误面板（无 Node.js 路径输入）
     */
    public static JPanel buildSimple(String title, String message) {
        JPanel errorPanel = new JPanel(new BorderLayout());
        errorPanel.setBackground(new Color(30, 30, 30));

        JLabel titleLabel = new JLabel(title);
        titleLabel.setFont(new Font("SansSerif", Font.BOLD, 16));
        titleLabel.setForeground(Color.WHITE);
        titleLabel.setBorder(BorderFactory.createEmptyBorder(20, 20, 10, 20));

        JTextArea textArea = new JTextArea(message);
        textArea.setEditable(false);
        textArea.setFont(new Font("Monospaced", Font.PLAIN, 12));
        textArea.setBackground(new Color(40, 40, 40));
        textArea.setForeground(new Color(220, 220, 220));
        textArea.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
        textArea.setLineWrap(true);
        textArea.setWrapStyleWord(true);

        errorPanel.add(titleLabel, BorderLayout.NORTH);
        errorPanel.add(new JScrollPane(textArea), BorderLayout.CENTER);

        return errorPanel;
    }
}
