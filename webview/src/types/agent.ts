/**
 * 智能体配置
 */
export interface AgentConfig {
  /** 唯一标识 */
  id: string;
  /** 智能体名称（最多20字符） */
  name: string;
  /** 提示词（最多10000字符） */
  prompt?: string;
  /** 创建时间戳 */
  createdAt?: number;
}

/**
 * 智能体操作结果
 */
export interface AgentOperationResult {
  success: boolean;
  operation: 'add' | 'update' | 'delete';
  error?: string;
}
