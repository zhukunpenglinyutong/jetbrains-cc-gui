import { useTranslation } from 'react-i18next';
import { McpSettingsSection } from '../../mcp/McpSettingsSection';
import styles from './style.module.less';

interface PlaceholderSectionProps {
  type: 'permissions' | 'mcp' | 'agents' | 'skills';
  currentProvider?: 'claude' | 'codex' | string;
}

const PlaceholderSection = ({ type, currentProvider }: PlaceholderSectionProps) => {
  const { t } = useTranslation();

  const sectionConfig = {
    permissions: {
      title: t('settings.permissions'),
      desc: t('settings.permissionsDesc'),
      icon: 'codicon-shield',
      message: t('settings.permissionsComingSoon'),
    },
    mcp: {
      title: t('settings.mcp'),
      desc: t('settings.mcpDesc'),
      icon: 'codicon-server',
      message: null, // MCP有专门的组件
    },
    agents: {
      title: t('settings.agents'),
      desc: t('settings.agentsDesc'),
      icon: 'codicon-robot',
      message: t('settings.agentsComingSoon'),
    },
    skills: {
      title: t('settings.skills'),
      desc: t('settings.skillsDesc'),
      icon: 'codicon-book',
      message: t('settings.skillsComingSoon'),
    },
  };

  const config = sectionConfig[type];

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{config.title}</h3>
      <p className={styles.sectionDesc}>{config.desc}</p>

      {type === 'mcp' ? (
        <McpSettingsSection currentProvider={currentProvider} />
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
