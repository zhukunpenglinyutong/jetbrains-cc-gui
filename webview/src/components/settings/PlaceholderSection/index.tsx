import { McpSettingsSection } from '../../mcp/McpSettingsSection';
import styles from './style.module.less';

interface PlaceholderSectionProps {
  type: 'permissions' | 'mcp' | 'agents' | 'skills';
}

const sectionConfig = {
  permissions: {
    title: '权限配置',
    desc: '管理 Claude Code 的文件访问和操作权限',
    icon: 'codicon-shield',
    message: '权限配置功能即将推出...',
  },
  mcp: {
    title: 'MCP服务器',
    desc: '配置和管理 Model Context Protocol 服务器',
    icon: 'codicon-server',
    message: null, // MCP有专门的组件
  },
  agents: {
    title: 'Agents',
    desc: '管理和配置AI代理',
    icon: 'codicon-robot',
    message: 'Agents配置功能即将推出...',
  },
  skills: {
    title: 'Skills',
    desc: '管理和配置技能模块',
    icon: 'codicon-book',
    message: 'Skills配置功能即将推出...',
  },
};

const PlaceholderSection = ({ type }: PlaceholderSectionProps) => {
  const config = sectionConfig[type];

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{config.title}</h3>
      <p className={styles.sectionDesc}>{config.desc}</p>

      {type === 'mcp' ? (
        <McpSettingsSection />
      ) : (
        <div className={styles.tempNotice}>
          <span className={`codicon ${config.icon}`} />
          <p>{config.message}</p>
        </div>
      )}
    </div>
  );
};

export default PlaceholderSection;
