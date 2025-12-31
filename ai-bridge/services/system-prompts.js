/**
 * 系统提示词管理模块
 *
 * 此模块负责构建发送给 AI 的各种系统提示词，包括：
 * - IDE 上下文信息提示词（当前打开的文件、选中的代码等）
 * - 其他系统级别的提示词
 *
 * 将提示词统一管理，便于维护和修改
 */

/**
 * 构建 IDE 上下文信息的系统提示词
 *
 * 此函数根据用户在 IDE 中的工作环境（打开的文件、选中的代码等），
 * 构建一段详细的系统提示词，帮助 AI 理解用户当前的代码上下文。
 *
 * @param {Object} openedFiles - IDE 中打开的文件信息
 * @param {string} openedFiles.active - 当前激活的文件路径（可能包含行号标记 #LX-Y）
 * @param {Object} openedFiles.selection - 用户选中的代码信息
 * @param {number} openedFiles.selection.startLine - 选中代码的起始行号
 * @param {number} openedFiles.selection.endLine - 选中代码的结束行号
 * @param {string} openedFiles.selection.selectedText - 选中的代码内容
 * @param {string[]} openedFiles.others - 其他打开的文件路径列表
 * @returns {string} 构建好的系统提示词，如果没有有效信息则返回空字符串
 */
function buildIDEContextPrompt(openedFiles) {
  if (!openedFiles || typeof openedFiles !== 'object') {
    return '';
  }

  const { active, selection, others } = openedFiles;
  const hasActive = active && active.trim() !== '';
  const hasSelection = selection && selection.selectedText;
  const hasOthers = Array.isArray(others) && others.length > 0;

  // 如果没有任何有效信息，返回空字符串
  if (!hasActive && !hasOthers) {
    return '';
  }

  console.log('[SystemPrompts] Building IDE context prompt with active file:', active,
              'selection:', hasSelection ? 'yes' : 'no',
              'other files:', others?.length || 0);

  let prompt = '\n\n## User\'s Current IDE Context\n\n';
  prompt += 'The user is working in an IDE. Below is their current workspace context, which provides critical information about what they are looking at and asking about:\n\n';

  // 优先级规则
  prompt += '**Context Priority Rules**:\n';
  prompt += '1. If code is selected → That specific code is the PRIMARY SUBJECT of the question\n';
  prompt += '2. If no code is selected → The currently active file is the PRIMARY SUBJECT\n';
  prompt += '3. Other open files → Secondary context that MAY be relevant to the question\n\n';

  // 文件路径格式说明
  prompt += '**File Path Format**: Paths may include line references: `#LX-Y` (lines X to Y) or `#LX` (single line X)\n\n';
  prompt += '---\n\n';

  // 当前激活的文件
  if (hasActive) {
    prompt += '### Currently Active File (User is viewing/editing this file)\n\n';
    prompt += `**File**: \`${active}\`\n\n`;

    if (hasSelection) {
      // 用户选中了代码
      prompt += `**User has selected lines ${selection.startLine}-${selection.endLine}** in this file. This selected code is what the user is specifically asking about:\n\n`;
      prompt += '```\n';
      prompt += selection.selectedText;
      prompt += '\n```\n\n';
      prompt += '**CRITICAL**: The selected code above is the PRIMARY FOCUS of the user\'s question.\n';
      prompt += '- When the user asks vague questions like "what\'s wrong with this", "explain this", "how to improve" → They are referring to THIS SELECTED CODE\n';
      prompt += '- Your answer should directly address this specific code section\n';
      prompt += '- If you need to reference other parts of the file or other files, do so as supporting context, but keep the selected code as your main focus\n\n';
    } else {
      // 没有选中代码
      prompt += '**No code is currently selected.** The user is viewing this file, so their question likely relates to:\n';
      prompt += '- The overall file content and structure\n';
      prompt += '- A specific class, function, or component in this file (infer from the question)\n';
      prompt += '- Code patterns or issues within this file\n\n';
      prompt += 'When answering, assume the user\'s question is about THIS FILE unless they explicitly mention another file.\n\n';
    }
  }

  // 其他打开的文件
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

  // 使用指南
  prompt += '---\n\n';
  prompt += '**How to use this context**:\n';
  prompt += '- If the user asks a vague question (e.g., "what does this do?", "is this correct?"), apply it to the PRIMARY FOCUS (selected code or active file)\n';
  prompt += '- If the user mentions "this file", "this code", "here" → They mean the active file or selected code\n';
  prompt += '- If the user asks about relationships or dependencies → Consider the other open files as potential references\n';
  prompt += '- Always prioritize the selected code > active file > other files when determining what the user is asking about\n\n';

  return prompt;
}

/**
 * 导出所有提示词构建函数
 */
export {
  buildIDEContextPrompt,
  // 未来可以在这里添加更多提示词构建函数
  // 例如：buildErrorContextPrompt, buildDebugContextPrompt 等
};
