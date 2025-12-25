import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getFileIcon } from '../../utils/fileIcons';
import type { FileItem } from './types';
import { fileReferenceProvider } from './providers/fileReferenceProvider';
import './FilePickerDropdown.css';
import { useTranslation } from 'react-i18next';

interface FilePickerDropdownProps {
  isVisible: boolean;
  onClose: () => void;
  onSelectFile: (file: FileItem) => void;
  position?: { bottom: number; left: number };
}

interface OpenTab {
  name: string;
  path: string;
  absolutePath?: string;
}

/**
 * FilePickerDropdown - 文件选择下拉菜单
 * 显示三个部分：
 * 1. 顶部按钮：添加磁盘文件（使用 IDE 文件选择器）
 * 2. 搜索框：搜索项目中的文件
 * 3. 打开的标签页列表（最多5个）
 */
export const FilePickerDropdown: React.FC<FilePickerDropdownProps> = ({
  isVisible,
  onClose,
  onSelectFile,
  position,
}) => {
  const { t } = useTranslation();
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FileItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 获取打开的标签页
  useEffect(() => {
    if (!isVisible) return;

    // 设置回调接收打开的标签页
    if (typeof window !== 'undefined') {
      window.onOpenTabsResult = (json: string) => {
        try {
          const data = JSON.parse(json);
          const tabs: OpenTab[] = data.tabs || data || [];
          // 最多显示5个
          setOpenTabs(tabs.slice(0, 5));
        } catch (error) {
          console.error('[FilePickerDropdown] Parse open tabs error:', error);
          setOpenTabs([]);
        }
      };
    }

    // 请求打开的标签页
    if (window.sendToJava) {
      window.sendToJava('get_open_tabs:{}');
    }

    // 聚焦搜索框
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);

    return () => {
      if (typeof window !== 'undefined') {
        delete window.onOpenTabsResult;
      }
    };
  }, [isVisible]);

  // 搜索文件 - 使用与 @ 触发相同的 fileReferenceProvider
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // 清除之前的超时
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // 防抖搜索
    searchTimeoutRef.current = window.setTimeout(async () => {
      setIsSearching(true);

      // 创建新的 AbortController
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        // 使用 fileReferenceProvider 进行搜索
        const files = await fileReferenceProvider(searchQuery, abortController.signal);

        // 检查是否被取消
        if (!abortController.signal.aborted) {
          // 最多显示10个搜索结果
          setSearchResults(files.slice(0, 10));
          setIsSearching(false);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // 请求被取消，忽略
          console.log('[FilePickerDropdown] Search aborted');
        } else {
          console.error('[FilePickerDropdown] Search error:', error);
          setSearchResults([]);
          setIsSearching(false);
        }
      }
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [searchQuery]);

  // 点击外部关闭
  useEffect(() => {
    if (!isVisible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isVisible, onClose]);

  // 处理键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  // 处理选择文件
  const handleSelectFile = useCallback((file: FileItem) => {
    onSelectFile(file);
    onClose();
    setSearchQuery('');
  }, [onSelectFile, onClose]);

  // 处理选择打开的标签页
  const handleSelectTab = useCallback((tab: OpenTab) => {
    const file: FileItem = {
      name: tab.name,
      path: tab.path,
      absolutePath: tab.absolutePath || tab.path,
      type: 'file',
    };
    handleSelectFile(file);
  }, [handleSelectFile]);

  // 打开 IDE 文件选择器
  const handleOpenFileChooser = useCallback(() => {
    if (window.sendToJava) {
      window.sendToJava('open_file_chooser:');
    }
    // 关闭下拉菜单（立即）
    onClose();
  }, [onClose]);

  // 获取文件图标
  const getFileIconSvg = (fileName: string) => {
    const extension = fileName.indexOf('.') !== -1 ? fileName.split('.').pop() : '';
    return getFileIcon(extension, fileName);
  };

  if (!isVisible) return null;

  return (
    <div
      ref={dropdownRef}
      className="file-picker-dropdown"
      style={{
        position: 'fixed',
        bottom: position?.bottom || 0,
        left: position?.left || 0,
        zIndex: 1000,
      }}
      onKeyDown={handleKeyDown}
    >
      {/* 添加磁盘文件按钮 */}
      <div className="file-picker-section">
        <button
          className="file-picker-add-button"
          onClick={handleOpenFileChooser}
          title={t('filePicker.addFromDiskTitle')}
        >
          <span className="codicon codicon-file-add" />
          <span>{t('filePicker.addFromDisk')}</span>
        </button>
      </div>

      {/* 搜索框 */}
      <div className="file-picker-section">
        <div className="file-picker-search">
          <span className="codicon codicon-search" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('filePicker.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="file-picker-search-input"
          />
          {searchQuery && (
            <button
              className="file-picker-search-clear"
              onClick={() => setSearchQuery('')}
              title={t('filePicker.clearSearch')}
            >
              <span className="codicon codicon-close" />
            </button>
          )}
        </div>
      </div>

      {/* 搜索结果 */}
      {searchQuery && (
        <div className="file-picker-section">
          <div className="file-picker-section-title">{t('filePicker.searchResults')}</div>
          <div className="file-picker-list">
            {isSearching ? (
              <div className="file-picker-loading">
                <span className="codicon codicon-loading codicon-modifier-spin" />
                <span>{t('filePicker.searching')}</span>
              </div>
            ) : searchResults.length > 0 ? (
              searchResults.map((file) => (
                <div
                  key={file.path}
                  className="file-picker-item"
                  onClick={() => handleSelectFile(file)}
                  title={file.absolutePath || file.path}
                >
                  <span
                    className="file-picker-item-icon"
                    dangerouslySetInnerHTML={{ __html: getFileIconSvg(file.name) }}
                  />
                  <div className="file-picker-item-content">
                    <div className="file-picker-item-name">{file.name}</div>
                    <div className="file-picker-item-path">{file.path}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="file-picker-empty">{t('filePicker.noMatches')}</div>
            )}
          </div>
        </div>
      )}

      {/* 打开的标签页 */}
      {!searchQuery && openTabs.length > 0 && (
        <div className="file-picker-section">
          <div className="file-picker-section-title">{t('filePicker.openFiles')}</div>
          <div className="file-picker-list">
            {openTabs.map((tab) => (
              <div
                key={tab.path}
                className="file-picker-item"
                onClick={() => handleSelectTab(tab)}
                title={tab.absolutePath || tab.path}
              >
                <span
                  className="file-picker-item-icon"
                  dangerouslySetInnerHTML={{ __html: getFileIconSvg(tab.name) }}
                />
                <div className="file-picker-item-content">
                  <div className="file-picker-item-name">{tab.name}</div>
                  <div className="file-picker-item-path">{tab.path}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {!searchQuery && openTabs.length === 0 && (
        <div className="file-picker-empty">
          <span className="codicon codicon-inbox" />
          <span>{t('filePicker.noOpenFiles')}</span>
        </div>
      )}
    </div>
  );
};

export default FilePickerDropdown;

