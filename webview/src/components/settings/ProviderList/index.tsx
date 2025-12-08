import { useState, useRef, useEffect } from 'react';
import type { ProviderConfig } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import ImportConfirmDialog from './ImportConfirmDialog';
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
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<any[]>([]);
  const [editingCcSwitchProvider, setEditingCcSwitchProvider] = useState<ProviderConfig | null>(null);
  const [convertingProvider, setConvertingProvider] = useState<ProviderConfig | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };

    // 注册全局回调函数供 Java 调用
    (window as any).import_preview_result = (dataOrStr: any) => {
        console.log('[Frontend] Received import_preview_result:', dataOrStr);
        let data = dataOrStr;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                console.error('Failed to parse import_preview_result data:', e);
            }
        }
        const event = new CustomEvent('import_preview_result', { detail: data });
        window.dispatchEvent(event);
    };

    (window as any).backend_notification = (dataOrStr: any) => {
        console.log('[Frontend] Received backend_notification:', dataOrStr);
        let data = dataOrStr;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                console.error('Failed to parse backend_notification data:', e);
            }
        }
        const event = new CustomEvent('backend_notification', { detail: data });
        window.dispatchEvent(event);
    };

    const handleImportPreview = (event: CustomEvent) => {
      setIsImporting(false); // 收到结果，关闭loading
      const data = event.detail;
      if (data && data.providers) {
        setImportPreviewData(data.providers);
        setShowImportDialog(true);
      }
    };

    const handleBackendNotification = (event: CustomEvent) => {
      setIsImporting(false); // 收到通知（可能是错误），关闭loading
      const data = event.detail;
      if (data && data.message) {
        addToast(data.message, data.type || 'info');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('import_preview_result', handleImportPreview as EventListener);
    window.addEventListener('backend_notification', handleBackendNotification as EventListener);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('import_preview_result', handleImportPreview as EventListener);
      window.removeEventListener('backend_notification', handleBackendNotification as EventListener);
      
      // 清理全局函数
      delete (window as any).import_preview_result;
      delete (window as any).backend_notification;
    };
  }, [addToast]);

  const handleEditClick = (provider: ProviderConfig) => {
    if (provider.source === 'cc-switch') {
      setEditingCcSwitchProvider(provider);
    } else {
      onEdit(provider);
    }
  };

  const handleConvert = () => {
    if (convertingProvider) {
      // 1. 生成新的 ID (例如在原 ID 后加 _custom 或 _local，或者保持原 ID 但删除 source)
      // 用户需求是"断开ID连接关系"，通常意味着 cc-switch 导入时是靠 ID 匹配的。
      // 如果我们保留原 ID 仅仅删除 source 字段：
      //   - 再次导入 cc-switch 时，因为 ID 相同，还是会匹配到并提示"更新"。
      //   - 覆盖更新后，source 字段又回来了。
      // 所以，如果要彻底"断开"，我们需要修改 ID。
      
      const oldId = convertingProvider.id;
      const newId = `${oldId}_local`; // 或者用 uuid，这里简单加后缀以示区分
      
      // 2. 构造新配置
      const newProvider = { 
          ...convertingProvider,
          id: newId,
          name: convertingProvider.name + ' (Local)', // 可选：修改名称避免混淆
      };
      delete newProvider.source;
      
      // 3. 保存新配置（作为新增）
      sendToJava('add_provider', newProvider);
      
      // 4. 删除旧配置
      sendToJava('delete_provider', { id: oldId });
      
      setConvertingProvider(null);
      addToast('转换成功，已生成新 ID 并断开关联', 'success');
      
      if (editingCcSwitchProvider && editingCcSwitchProvider.id === convertingProvider.id) {
          setEditingCcSwitchProvider(null);
          // 继续编辑新的 provider
          onEdit(newProvider);
      }
    }
  };

  return (
    <div className={styles.container}>
      {/* 导入弹窗 */}
      {showImportDialog && (
        <ImportConfirmDialog
          providers={importPreviewData}
          existingProviders={providers}
          onConfirm={(selectedProviders) => {
            sendToJava('save_imported_providers', { providers: selectedProviders });
            setShowImportDialog(false);
          }}
          onCancel={() => setShowImportDialog(false)}
        />
      )}

      {/* 导入加载中 */}
      {isImporting && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingContent}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>正在读取 cc-switch 配置...</span>
          </div>
        </div>
      )}

      {/* 编辑警告弹窗 */}
      {editingCcSwitchProvider && (
          <div className={styles.warningOverlay}>
              <div className={styles.warningDialog}>
                  <div className={styles.warningTitle}>
                      <span className="codicon codicon-warning" />
                      编辑 cc-switch 配置
                  </div>
                  <div className={styles.warningContent}>
                      您当前正在编辑 cc-switch 类型配置，编辑此配置不会更新 cc-switch，相反导入的时候有可能会覆盖您的配置，建议您将 cc-switch 配置转为本插件配置再进行编辑。
                  </div>
                  <div className={styles.warningActions}>
                      <button 
                          className={styles.btnSecondary} 
                          onClick={() => setEditingCcSwitchProvider(null)}
                      >
                          取消
                      </button>
                      <button 
                          className={styles.btnSecondary} 
                          onClick={() => {
                              const p = editingCcSwitchProvider;
                              setEditingCcSwitchProvider(null);
                              onEdit(p);
                          }}
                      >
                          继续编辑
                      </button>
                      <button 
                          className={styles.btnWarning} 
                          onClick={() => {
                              setConvertingProvider(editingCcSwitchProvider);
                              // setEditingCcSwitchProvider(null); // 保持 null 以便在转换后处理
                          }}
                      >
                          转换并编辑
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* 转换确认弹窗 */}
      {convertingProvider && (
          <div className={styles.warningOverlay}>
              <div className={styles.warningDialog}>
                  <div className={styles.warningTitle}>
                      <span className="codicon codicon-arrow-swap" />
                      转换为插件配置
                  </div>
                  <div className={styles.warningContent}>
                      是否将 cc-switch 配置 "{convertingProvider.name}" 转换为本插件配置？<br/><br/>
                      转换后将断开与 cc-switch 的 ID 连接关系，后续导入 cc-switch 数据时不会覆盖此配置。
                  </div>
                  <div className={styles.warningActions}>
                      <button 
                          className={styles.btnSecondary} 
                          onClick={() => {
                              setConvertingProvider(null);
                              // 如果是从编辑来的，取消转换意味着取消编辑
                              if (editingCcSwitchProvider) {
                                  setEditingCcSwitchProvider(null);
                              }
                          }}
                      >
                          取消
                      </button>
                      <button 
                          className={styles.btnPrimary} 
                          onClick={handleConvert}
                      >
                          确认转换
                      </button>
                  </div>
              </div>
          </div>
      )}

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
                    setIsImporting(true); // 开始加载
                    sendToJava('preview_cc_switch_import');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  从cc-switch导入/更新
                </div>
                <div 
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast('功能暂未实现，敬请期待', 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  从cc-switch CLI导入/更新
                </div>
                <div 
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast('功能暂未实现，敬请期待', 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  从Claude Code Router导入/更新
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
                {(provider.remark || provider.websiteUrl) && (
                  <div className={styles.website} title={provider.remark || provider.websiteUrl}>
                    {provider.remark || provider.websiteUrl}
                  </div>
                )}
                {provider.source === 'cc-switch' && (
                    <div className={styles.ccSwitchBadge}>
                        cc-switch
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
                  {provider.source === 'cc-switch' && (
                    <button 
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConvertingProvider(provider);
                      }}
                      title="转换为插件配置"
                    >
                      <span className="codicon codicon-arrow-swap" />
                    </button>
                  )}
                  <button 
                    className={styles.iconBtn}
                    onClick={() => handleEditClick(provider)}
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
