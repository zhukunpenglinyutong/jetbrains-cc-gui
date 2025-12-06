import styles from './style.module.less';

interface SettingsHeaderProps {
  onClose: () => void;
}

const SettingsHeader = ({ onClose }: SettingsHeaderProps) => {
  return (
    <div className={styles.header}>
      <div className={styles.headerLeft}>
        <button className={styles.backBtn} onClick={onClose}>
          <span className="codicon codicon-arrow-left" />
        </button>
        <h2 className={styles.title}>设置</h2>
      </div>
    </div>
  );
};

export default SettingsHeader;
