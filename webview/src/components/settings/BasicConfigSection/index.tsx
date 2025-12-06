import styles from './style.module.less';

interface BasicConfigSectionProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  nodePath: string;
  onNodePathChange: (path: string) => void;
  onSaveNodePath: () => void;
  savingNodePath: boolean;
}

const BasicConfigSection = ({
  theme,
  onThemeChange,
  nodePath,
  onNodePathChange,
  onSaveNodePath,
  savingNodePath,
}: BasicConfigSectionProps) => {
  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>基础配置</h3>
      <p className={styles.sectionDesc}>配置页面主题和 Node.js 运行环境</p>

      {/* 主题切换 */}
      <div className={styles.themeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-color" />
          <span className={styles.fieldLabel}>界面主题</span>
        </div>

        <div className={styles.themeGrid}>
          {/* 亮色主题卡片 */}
          <div
            className={`${styles.themeCard} ${theme === 'light' ? styles.active : ''}`}
            onClick={() => onThemeChange('light')}
          >
            {theme === 'light' && (
              <div className={styles.checkBadge}>
                <span className="codicon codicon-check" />
              </div>
            )}

            <div className={styles.themeIconLight}>
              <span className="codicon codicon-symbol-color" />
            </div>

            <div className={styles.themeCardTitle}>亮色主题</div>
            <div className={styles.themeCardDesc}>清爽明亮，适合白天使用</div>
          </div>

          {/* 暗色主题卡片 */}
          <div
            className={`${styles.themeCard} ${theme === 'dark' ? styles.active : ''}`}
            onClick={() => onThemeChange('dark')}
          >
            {theme === 'dark' && (
              <div className={styles.checkBadge}>
                <span className="codicon codicon-check" />
              </div>
            )}

            <div className={styles.themeIconDark}>
              <span className="codicon codicon-symbol-event" />
            </div>

            <div className={styles.themeCardTitle}>暗色主题</div>
            <div className={styles.themeCardDesc}>护眼舒适，适合夜间使用</div>
          </div>
        </div>
      </div>

      {/* Node.js 路径配置 */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-terminal" />
          <span className={styles.fieldLabel}>Node.js 路径</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder="例如 C:\Program Files\nodejs\node.exe 或 /usr/local/bin/node"
            value={nodePath}
            onChange={(e) => onNodePathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveNodePath}
            disabled={savingNodePath}
          >
            {savingNodePath && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            保存
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          在终端中运行 <code>node -p &quot;process.execPath&quot;</code> 获取实际的 Node.js 可执行文件路径。
          为空时插件会自动尝试检测 Node.js。
        </small>
      </div>
    </div>
  );
};

export default BasicConfigSection;
