/**
 * 提示词库配置
 */
export interface PromptConfig {
  /** 唯一标识 */
  id: string;
  /** 提示词名称（最多30字符） */
  name: string;
  /** 提示词内容（最多100000字符） */
  content: string;
  /** 创建时间戳 */
  createdAt?: number;
  /** 更新时间戳 */
  updatedAt?: number;
}

/**
 * 提示词操作结果
 */
export interface PromptOperationResult {
  success: boolean;
  operation: 'add' | 'update' | 'delete';
  error?: string;
}
