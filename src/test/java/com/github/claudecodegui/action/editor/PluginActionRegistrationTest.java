package com.github.claudecodegui.action.editor;

import org.junit.Assert;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.File;
import java.util.HashSet;
import java.util.Set;

public class PluginActionRegistrationTest {

    @Test
    public void sendFilePathActionAppearsInProjectTreeAndEditorTabMenus() throws Exception {
        Set<String> groupIds = getActionGroupIds("ClaudeCodeGUI.SendFilePathToInputAction");

        Assert.assertTrue(groupIds.contains("ProjectViewPopupMenu"));
        Assert.assertTrue(groupIds.contains("EditorTabPopupMenu"));
    }

    private static Set<String> getActionGroupIds(String actionId) throws Exception {
        Document document = DocumentBuilderFactory.newInstance()
                .newDocumentBuilder()
                .parse(new File("src/main/resources/META-INF/plugin.xml"));
        NodeList actions = document.getElementsByTagName("action");
        for (int i = 0; i < actions.getLength(); i++) {
            Element action = (Element) actions.item(i);
            if (actionId.equals(action.getAttribute("id"))) {
                Set<String> groupIds = new HashSet<>();
                NodeList addToGroups = action.getElementsByTagName("add-to-group");
                for (int j = 0; j < addToGroups.getLength(); j++) {
                    Element addToGroup = (Element) addToGroups.item(j);
                    groupIds.add(addToGroup.getAttribute("group-id"));
                }
                return groupIds;
            }
        }
        throw new AssertionError("Action not found: " + actionId);
    }
}
