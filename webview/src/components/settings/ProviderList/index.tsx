import { useState, useRef, useEffect } from 'react';
import type { ProviderConfig } from '../../../types/provider';
import styles from './style.module.less';

interface ProviderListProps {
  providers: ProviderConfig[];
  onAdd: () => void;
  onEdit: (provider: ProviderConfig) => void;
  onDelete: (provider: ProviderConfig) => void;
  onSwitch: (id: string) => void;
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  emptyState?: React.ReactNode;
}

export default function ProviderList({
  providers,
  onAdd,
  onEdit,
  onDelete,
  onSwitch,
  addToast,
  emptyState,
}: ProviderListProps) {
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h4 className={styles.title}>所有供应商</h4>
        
        <div className={styles.actions}>
          <div className={styles.importMenuWrapper} ref={importMenuRef}>
            <button 
              className={styles.btnSecondary} 
              onClick={() => setImportMenuOpen(!importMenuOpen)}
            >
              <span className="codicon codicon-cloud-download" />
              导入
            </button>
            
            {importMenuOpen && (
              <div className={styles.importMenu}>
                <div 
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast('功能暂未实现，敬请期待', 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  从cc-switch导入
                </div>
                <div 
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast('功能暂未实现，敬请期待', 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  从cc-switch CLI导入
                </div>
                <div 
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast('功能暂未实现，敬请期待', 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  从Claude Code Router导入
                </div>
              </div>
            )}
          </div>

          <button 
            className={styles.btnPrimary} 
            onClick={onAdd}
          >
            <span className="codicon codicon-add" />
            添加
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {providers.length > 0 ? (
          providers.map((provider) => (
            <div 
              key={provider.id} 
              className={`${styles.card} ${provider.isActive ? styles.active : ''}`}
            >
              <div className={styles.cardInfo}>
                <div className={styles.name}>
                  {provider.name}
                </div>
                {provider.websiteUrl && (
                  <div className={styles.website}>
                    官网：
                    <span 
                      className={styles.websiteLink}
                      title={provider.websiteUrl}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(provider.websiteUrl || '');
                        addToast('链接已复制到剪切板', 'success');
                      }}
                    >
                      {provider.websiteUrl}
                    </span>
                  </div>
                )}
              </div>
              
              <div className={styles.cardActions}>
                {provider.isActive ? (
                  <div className={styles.activeBadge}>
                    <span className="codicon codicon-check" />
                    使用中
                  </div>
                ) : (
                  <button 
                    className={styles.useButton}
                    onClick={() => onSwitch(provider.id)}
                  >
                    <span className="codicon codicon-play" />
                    启用
                  </button>
                )}
                
                <div className={styles.divider}></div>
                
                <div className={styles.actionButtons}>
                  <button 
                    className={styles.iconBtn}
                    onClick={() => onEdit(provider)}
                    title="编辑"
                  >
                    <span className="codicon codicon-edit" />
                  </button>
                  <button 
                    className={styles.iconBtn}
                    onClick={() => onDelete(provider)}
                    title="删除"
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                </div>
              </div>
            </div>
          ))
        ) : (
          emptyState && (
            <div className={styles.emptyState}>
              {emptyState}
            </div>
          )
        )}
      </div>
    </div>
  );
}
