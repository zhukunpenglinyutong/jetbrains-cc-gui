/**
 * System prompt management module.
 *
 * This module builds various system prompts sent to the AI, including:
 * - IDE context information prompts (currently open files, selected code, etc.)
 * - Other system-level prompts
 *
 * Centralizes prompt management for easier maintenance and modification.
 */
import { getWindowsPathConstraint } from '../utils/prompt-utils.js';

/**
 * Build the IDE context system prompt.
 *
 * This function constructs a detailed system prompt based on the user's working environment
 * in the IDE (open files, selected code, workspace structure, etc.), helping the AI understand
 * the user's current code context.
 *
 * @param {Object} openedFiles - Information about files open in the IDE
 * @param {string} openedFiles.active - Path of the currently active file (may include line markers #LX-Y)
 * @param {Object} openedFiles.selection - User's code selection information
 * @param {number} openedFiles.selection.startLine - Starting line number of the selection
 * @param {number} openedFiles.selection.endLine - Ending line number of the selection
 * @param {string} openedFiles.selection.selectedText - Content of the selected code
 * @param {string[]} openedFiles.others - List of other open file paths
 * @param {boolean} openedFiles.isWorkspace - Whether this is a multi-project workspace
 * @param {string} openedFiles.workspaceRoot - Root path of the workspace
 * @param {Array} openedFiles.subprojects - List of subprojects in the workspace
 * @param {Array} openedFiles.modules - List of modules in the project
 * @param {string} openedFiles.activeSubproject - Name of the subproject containing the active file
 * @param {string} agentPrompt - Agent prompt (optional)
 * @returns {string} The constructed system prompt, or an empty string if there's no valid information
 */
function buildIDEContextPrompt(openedFiles, agentPrompt = null) {
  // Build the agent prompt section (if present)
  let prompt = '';

  if (agentPrompt && typeof agentPrompt === 'string' && agentPrompt.trim() !== '') {
    console.log('[Agent] ✓ buildIDEContextPrompt: Adding agent prompt to system context');
    console.log('[Agent] ✓ Agent prompt preview:', agentPrompt.length > 100 ? agentPrompt.substring(0, 100) + '...' : agentPrompt);
    prompt += '\n\n## Agent Role and Instructions\n\n';
    prompt += 'You are acting as a specialized agent with the following role and instructions:\n\n';
    prompt += agentPrompt.trim();
    prompt += '\n\n**IMPORTANT**: Follow the above role and instructions throughout this conversation.\n';
    prompt += '\n---\n';
  } else {
    console.log('[Agent] ✗ buildIDEContextPrompt: No agent prompt provided');
  }

  prompt += getWindowsPathConstraint({ extra: 'Apply this rule going forward, not just for this file.' });

  if (!openedFiles || typeof openedFiles !== 'object') {
    // If there's only an agent prompt with no IDE context, still return the agent prompt
    return prompt;
  }

  const { active, selection, others, isWorkspace, workspaceRoot, subprojects, modules, activeSubproject } = openedFiles;
  const hasActive = active && active.trim() !== '';
  const hasSelection = selection && selection.selectedText;
  const hasOthers = Array.isArray(others) && others.length > 0;
  const hasWorkspace = !!isWorkspace;
  const hasModules = Array.isArray(modules) && modules.length > 1;

  // If there's no valid information, return only the agent prompt (if any)
  if (!hasActive && !hasOthers && !hasWorkspace && !hasModules) {
    return prompt;
  }

  console.log('[SystemPrompts] Building IDE context prompt with active file:', active,
              'selection:', hasSelection ? 'yes' : 'no',
              'other files:', others?.length || 0,
              'workspace:', hasWorkspace ? 'yes' : 'no',
              'modules:', modules?.length || 0);

  prompt += '\n\n## User\'s Current IDE Context\n\n';
  prompt += 'The user is working in an IDE. Below is their current workspace context, which provides critical information about what they are looking at and asking about:\n\n';

  // Workspace/Multi-project context (highest priority for project structure understanding)
  if (hasWorkspace) {
    prompt += '### Multi-Project Workspace Structure\n\n';
    prompt += 'You are working in a **multi-project workspace** environment. This is important for understanding project boundaries and dependencies:\n\n';

    if (workspaceRoot) {
      prompt += `**Workspace Root**: \`${workspaceRoot}\`\n\n`;
    }

    if (Array.isArray(subprojects) && subprojects.length > 0) {
      prompt += '**Subprojects in this workspace**:\n';
      for (const sp of subprojects) {
        const name = sp.name || 'unknown';
        const path = sp.path || '';
        const type = sp.type || '';
        const loaded = sp.loaded !== false; // Default to true if not specified

        prompt += `- **${name}**`;
        if (type) {
          prompt += ` (${type})`;
        }
        if (!loaded) {
          prompt += ' [not loaded]';
        }
        prompt += `: \`${path}\`\n`;
      }
      prompt += '\n';
    }

    if (activeSubproject) {
      prompt += `**Current Context**: The active file belongs to subproject **${activeSubproject}**\n\n`;
    }

    prompt += '**Workspace Guidelines**:\n';
    prompt += '- Each subproject may have its own build configuration, dependencies, and module structure\n';
    prompt += '- When editing files, consider which subproject they belong to\n';
    prompt += '- Cross-subproject references should be handled carefully (different package structures, etc.)\n';
    prompt += '- Build commands should target the appropriate subproject\n\n';
    prompt += '---\n\n';
  } else if (hasModules) {
    // Single project with multiple modules
    prompt += '### Project Module Structure\n\n';
    prompt += 'This project contains multiple modules:\n';
    for (const mod of modules) {
      const name = mod.name || 'unknown';
      prompt += `- \`${name}\`\n`;
    }
    prompt += '\n**Note**: When editing files, consider which module they belong to and the module-specific configuration.\n\n';
    prompt += '---\n\n';
  }

  // Priority rules
  prompt += '**Context Priority Rules**:\n';
  prompt += '1. If code is selected → That specific code is the PRIMARY SUBJECT of the question\n';
  prompt += '2. If no code is selected → The currently active file is the PRIMARY SUBJECT\n';
  prompt += '3. Other open files → Secondary context that MAY be relevant to the question\n';
  if (hasWorkspace) {
    prompt += '4. Workspace structure → Helps understand project boundaries and dependencies\n';
  }
  prompt += '\n';

  // File path format explanation
  prompt += '**File Path Format**: Paths may include line references: `#LX-Y` (lines X to Y) or `#LX` (single line X)\n\n';
  prompt += '---\n\n';

  // Currently active file
  if (hasActive) {
    prompt += '### Currently Active File (User is viewing/editing this file)\n\n';
    prompt += `**File**: \`${active}\`\n\n`;

    if (hasSelection) {
      // User has selected code
      prompt += `**User has selected lines ${selection.startLine}-${selection.endLine}** in this file. This selected code is what the user is specifically asking about:\n\n`;
      prompt += '```\n';
      prompt += selection.selectedText;
      prompt += '\n```\n\n';
      prompt += '**CRITICAL**: The selected code above is the PRIMARY FOCUS of the user\'s question.\n';
      prompt += '- When the user asks vague questions like "what\'s wrong with this", "explain this", "how to improve" → They are referring to THIS SELECTED CODE\n';
      prompt += '- Your answer should directly address this specific code section\n';
      prompt += '- If you need to reference other parts of the file or other files, do so as supporting context, but keep the selected code as your main focus\n\n';
    } else {
      // No code selected
      prompt += '**No code is currently selected.** The user is viewing this file, so their question likely relates to:\n';
      prompt += '- The overall file content and structure\n';
      prompt += '- A specific class, function, or component in this file (infer from the question)\n';
      prompt += '- Code patterns or issues within this file\n\n';
      prompt += 'When answering, assume the user\'s question is about THIS FILE unless they explicitly mention another file.\n\n';
    }
  }

  // Other open files
  if (hasOthers) {
    prompt += '### Other Open Files (Secondary context)\n\n';
    prompt += 'The user also has these files open in their IDE. These files:\n';
    prompt += '- MAY be related to the current question (e.g., dependencies, related modules, test files)\n';
    prompt += '- Should be considered as supporting context, NOT the primary subject\n';
    prompt += '- Can be referenced if they help answer the question about the active file/selected code\n\n';
    others.forEach(file => {
      prompt += `- \`${file}\`\n`;
    });
    prompt += '\n**Note**: Only reference these files if they are directly relevant to answering the user\'s question about the active file or selected code.\n\n';
  }

  // Usage guide
  prompt += '---\n\n';
  prompt += '**How to use this context**:\n';
  prompt += '- If the user asks a vague question (e.g., "what does this do?", "is this correct?"), apply it to the PRIMARY FOCUS (selected code or active file)\n';
  prompt += '- If the user mentions "this file", "this code", "here" → They mean the active file or selected code\n';
  prompt += '- If the user asks about relationships or dependencies → Consider the other open files as potential references\n';
  prompt += '- Always prioritize the selected code > active file > other files when determining what the user is asking about\n';
  if (hasWorkspace) {
    prompt += '- For build/run commands, target the appropriate subproject (ask if unclear)\n';
  }
  prompt += '\n';

  return prompt;
}

/**
 * Export all prompt building functions.
 */
export {
  buildIDEContextPrompt,
  // Additional prompt building functions can be added here in the future
  // e.g.: buildErrorContextPrompt, buildDebugContextPrompt, etc.
};
