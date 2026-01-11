/**
 * Quick Fix 专用提示词构建模块
 */

/**
 * 构建加强版 IDE 上下文信息的系统提示词 (用于 Quick Fix)
 * 包含 PSI, Lombok, 错误诊断等深度分析
 */
function buildEnhancedIDEContextPrompt(openedFiles, agentPrompt = null) {
    let prompt = '';

    if (agentPrompt && typeof agentPrompt === 'string' && agentPrompt.trim() !== '') {
        prompt += '\n\n## Agent Role and Instructions\n\n';
        prompt += 'You are acting as a specialized agent with the following role and instructions:\n\n';
        prompt += agentPrompt.trim();
        prompt += '\n\n**IMPORTANT**: Follow the above role and instructions throughout this conversation.\n';
        prompt += '\n---\n';
    }

    // Windows路径格式约束
    prompt += '\n\n## CRITICAL: File Path Format Requirement\n\n';
    prompt += '**IMPORTANT**: There\'s a file modification bug in Claude Code. The workaround is: always use complete absolute Windows paths with drive letters and backslashes for ALL file operations.\n\n';
    prompt += '**Examples**:\n';
    prompt += '- ✅ Correct: `C:\\Users\\username\\project\\src\\file.js`\n';
    prompt += '- ❌ Wrong: `/c/Users/username/project/src/file.js`\n';
    prompt += '- ❌ Wrong: `./src/file.js` (relative paths)\n\n';
    prompt += '---\n\n';

    if (!openedFiles || typeof openedFiles !== 'object') {
        return prompt;
    }

    const { active, selection, others, scope, references, classHierarchy, fields, annotations, methodCalls, imports, errors, comments, package: packageName, inspections, highlights, quickFixes, injectedLanguages } = openedFiles;
    const hasActive = active && active.trim() !== '';
    const hasSelection = selection && selection.selectedText;

    prompt += '\n\n## User\'s Current IDE Context\n\n';
    prompt += 'The user is working in an IDE. Below is their current workspace context.\n\n';

    // Context Priority Rules
    prompt += '**Context Priority Rules**:\n';
    prompt += '1. If code is selected → That specific code is the PRIMARY SUBJECT\n';
    prompt += '2. If no code is selected → The currently active file is the PRIMARY SUBJECT\n';
    prompt += '3. PSI semantic context → Use this to understand code structure and relationships\n\n';

    // Package Info
    if (packageName) {
        prompt += `**Package**: \`${packageName}\`\n\n`;
    }

    // Currently Active File
    if (hasActive) {
        prompt += '### Currently Active File\n\n';
        prompt += `**File**: \`${active}\`\n\n`;

        // PSI Scope
        if (scope) {
            if (scope.method) {
                prompt += `- **Method**: \`${scope.method}\`\n`;
                if (scope.methodSignature) prompt += `  - Signature: \`${scope.methodSignature}\`\n`;
            }
            if (scope.class) prompt += `- **Class**: \`${scope.class}\`\n`;
            prompt += '\n';
        }

        // Focused Code Context
        if (openedFiles.selectedFunctions && openedFiles.selectedFunctions.length > 0) {
            prompt += '### Focused Code Context\n';
            openedFiles.selectedFunctions.forEach(func => {
                prompt += `#### Method: \`${func.name}\`\n`;
                prompt += `- **Location**: Lines ${func.startLine}-${func.endLine}\n`;
                prompt += '```java\n';
                prompt += func.content;
                prompt += '\n```\n\n';
            });
        } else if (openedFiles.currentWindow && openedFiles.currentWindow.content) {
            const win = openedFiles.currentWindow;
            prompt += `#### Code View (Lines ${win.startLine}-${win.endLine})\n`;
            prompt += '```java\n';
            prompt += win.content;
            prompt += '\n```\n\n';
        }

        // Lombok Detection
        const usesLombok = (annotations && annotations.some(a => (typeof a === 'string' && a.toLowerCase().includes('lombok'))));
        if (usesLombok) {
            prompt += '> **INFO**: Lombok detected. Assume all getters/setters/constructors are available.\n\n';
        }

        if (hasSelection) {
            prompt += `**User has selected lines ${selection.startLine}-${selection.endLine}**. This is the focus:\n\n`;
            prompt += '```\n';
            prompt += selection.selectedText;
            prompt += '\n```\n\n';
        }
    }

    // Inspections, Highlights, Errors
    if (inspections && inspections.length > 0) {
        prompt += '#### Code Inspections\n';
        inspections.forEach(insp => {
            prompt += `- ${insp.inspection} (${insp.severity}): ${insp.description}\n`;
        });
        prompt += '\n';
    }

    if (highlights && highlights.length > 0) {
        prompt += '#### Editor Highlights\n';
        highlights.forEach(hl => {
            prompt += `- Line ${hl.line} (${hl.severity}): ${hl.description}\n`;
        });
        prompt += '\n';
    }

    return prompt;
}

/**
 * 构建 Quick Fix 专用系统提示词
 */
export function buildQuickFixPrompt(openedFiles, userPrompt) {
    let prompt = buildEnhancedIDEContextPrompt(openedFiles);

    prompt += '\n\n## QUICK FIX INSTRUCTIONS\n\n';
    prompt += 'You are in QUICK FIX mode. The user wants to specifically fix or improve the code at their cursor or selection.\n';
    prompt += `User's Request: "${userPrompt}"\n\n`;

    prompt += '### YOUR CORE TASK:\n';
    prompt += '1. Analyze the provided context perfectly.\n';
    prompt += '2. **FORMAT REQUIREMENT**: You MUST provide the full updated content of the active file within a triplet of backticks with the language specified (e.g., ```java). The Java backend will use this full content to show a Diff.\n';
    prompt += '3. Start your response with a brief explanation of what you fixed, followed by the code block.\n';

    return prompt;
}
