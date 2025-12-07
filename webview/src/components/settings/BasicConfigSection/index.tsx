import styles from './style.module.less';

const SunIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 17C14.7614 17 17 14.7614 17 12C17 9.23858 14.7614 7 12 7C9.23858 7 7 9.23858 7 12C7 14.7614 9.23858 17 12 17Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 1V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 21V23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.22 4.22L5.64 5.64" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18.36 18.36L19.78 19.78" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M1 12H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M21 12H23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.22 19.78L5.64 18.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18.36 5.64L19.78 4.22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const MoonIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

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
              <SunIcon />
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
              <MoonIcon />
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
          <span>
            在终端中运行 <code>node -p &quot;process.execPath&quot;</code> 获取实际的 Node.js 可执行文件路径。
            为空时插件会自动尝试检测 Node.js。
          </span>
        </small>
      </div>
    </div>
  );
};

export default BasicConfigSection;
