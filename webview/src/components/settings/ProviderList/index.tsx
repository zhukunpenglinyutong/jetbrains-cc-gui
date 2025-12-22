import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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

    (window as any).backend_notification = (...args: any[]) => {
        console.log('[Frontend] Received backend_notification args:', args);
        let data: any = {};
        
        // 支持多参数调用 (type, title, message) 以避免 JSON 解析问题
        if (args.length >= 3 && typeof args[0] === 'string' && typeof args[2] === 'string') {
            data = {
                type: args[0],
                title: args[1],
                message: args[2]
            };
        } else if (args.length > 0) {
            // 兼容旧的单参数 JSON 方式
            let dataOrStr = args[0];
            data = dataOrStr;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch (e) {
                    console.error('Failed to parse backend_notification data:', e);
                }
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
      addToast(t('settings.provider.convertSuccess'), 'success');

      if (editingCcSwitchProvider && editingCcSwitchProvider.id === convertingProvider.id) {
          setEditingCcSwitchProvider(null);
          // 继续编辑新的 provider
          onEdit(newProvider);
      }
    }
  };

  const handleSelectFileClick = () => {
    setImportMenuOpen(false);
    setIsImporting(true);
    // 让后端打开系统文件选择器，这样可以获取正确的绝对路径
    sendToJava('open_file_chooser_for_cc_switch');
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
            <span>{t('settings.provider.readingCcSwitch')}</span>
          </div>
        </div>
      )}

      {/* 编辑警告弹窗 */}
      {editingCcSwitchProvider && (
          <div className={styles.warningOverlay}>
              <div className={styles.warningDialog}>
                  <div className={styles.warningTitle}>
                      <span className="codicon codicon-warning" />
                      {t('settings.provider.editCcSwitchTitle')}
                  </div>
                  <div className={styles.warningContent}>
                      {t('settings.provider.editCcSwitchWarning')}
                  </div>
                  <div className={styles.warningActions}>
                      <button
                          className={styles.btnSecondary}
                          onClick={() => setEditingCcSwitchProvider(null)}
                      >
                          {t('common.cancel')}
                      </button>
                      <button
                          className={styles.btnSecondary}
                          onClick={() => {
                              const p = editingCcSwitchProvider;
                              setEditingCcSwitchProvider(null);
                              onEdit(p);
                          }}
                      >
                          {t('settings.provider.continueEdit')}
                      </button>
                      <button
                          className={styles.btnWarning}
                          onClick={() => {
                              setConvertingProvider(editingCcSwitchProvider);
                              // setEditingCcSwitchProvider(null); // 保持 null 以便在转换后处理
                          }}
                      >
                          {t('settings.provider.convertAndEdit')}
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
                      {t('settings.provider.convertToPlugin')}
                  </div>
                  <div className={styles.warningContent}>
                      {t('settings.provider.convertConfirmMessage', { name: convertingProvider.name })}<br/><br/>
                      {t('settings.provider.convertDetailMessage')}
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
                          {t('common.cancel')}
                      </button>
                      <button
                          className={styles.btnPrimary}
                          onClick={handleConvert}
                      >
                          {t('settings.provider.confirmConvert')}
                      </button>
                  </div>
              </div>
          </div>
      )}

      <div className={styles.header}>
        <h4 className={styles.title}>{t('settings.provider.allProviders')}</h4>

        <div className={styles.actions}>
          <div className={styles.importMenuWrapper} ref={importMenuRef}>
            <button
              className={styles.btnSecondary}
              onClick={() => setImportMenuOpen(!importMenuOpen)}
            >
              <span className="codicon codicon-cloud-download" />
              {t('settings.provider.import')}
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
                  {t('settings.provider.importFromCcSwitchUpdate')}
                </div>
                <div
                  className={styles.importMenuItem}
                  onClick={handleSelectFileClick}
                >
                  <span className="codicon codicon-file" />
                  {t('settings.provider.importFromCcSwitchFile')}
                </div>
                {/* <div
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast(t('settings.provider.featureComingSoon'), 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  {t('settings.provider.importFromCcSwitchCli')}
                </div>
                <div
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast(t('settings.provider.featureComingSoon'), 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  {t('settings.provider.importFromClaudeRouter')}
                </div> */}
              </div>
            )}
          </div>

          <button
            className={styles.btnPrimary}
            onClick={onAdd}
          >
            <span className="codicon codicon-add" />
            {t('common.add')}
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
                    {t('settings.provider.inUse')}
                  </div>
                ) : (
                  <button
                    className={styles.useButton}
                    onClick={() => onSwitch(provider.id)}
                  >
                    <span className="codicon codicon-play" />
                    {t('settings.provider.enable')}
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
                      title={t('settings.provider.convertToPlugin')}
                    >
                      <span className="codicon codicon-arrow-swap" />
                    </button>
                  )}
                  <button
                    className={styles.iconBtn}
                    onClick={() => handleEditClick(provider)}
                    title={t('common.edit')}
                  >
                    <span className="codicon codicon-edit" />
                  </button>
                  <button
                    className={styles.iconBtn}
                    onClick={() => onDelete(provider)}
                    title={t('common.delete')}
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
