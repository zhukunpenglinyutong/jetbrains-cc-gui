import type { DropdownItemProps } from '../types';

/**
 * DropdownItem - 下拉菜单项组件
 */
export const DropdownItem = ({
  item,
  isActive = false,
  onClick,
  onMouseEnter,
}: DropdownItemProps) => {
  /**
   * 渲染图标
   */
  const renderIcon = () => {
    // 如果 icon 包含 SVG 标签，说明是内联 SVG
    if (item.icon?.startsWith('<svg')) {
      return (
        <span
          className="dropdown-item-icon"
          dangerouslySetInnerHTML={{ __html: item.icon }}
          style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        />
      );
    }

    // 否则使用 codicon 类名
    const iconClass = item.icon || getDefaultIconClass(item.type);
    return <span className={`dropdown-item-icon codicon ${iconClass}`} />;
  };

  /**
   * 获取默认图标类名（用于 codicon）
   */
  const getDefaultIconClass = (type?: string): string => {
    switch (type) {
      case 'file':
        return 'codicon-file';
      case 'directory':
        return 'codicon-folder';
      case 'command':
        return 'codicon-terminal';
      default:
        return 'codicon-symbol-misc';
    }
  };

  // 分隔线
  if (item.type === 'separator') {
    return <div className="dropdown-separator" />;
  }

  // 分组标题
  if (item.type === 'section-header') {
    return (
      <div className="dropdown-section-header">
        {item.label}
      </div>
    );
  }

  // 所有项都可以选择
  const isDisabled = false;

  return (
    <div
      className={`dropdown-item ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
      onClick={isDisabled ? undefined : onClick}
      onMouseEnter={isDisabled ? undefined : onMouseEnter}
      style={isDisabled ? { cursor: 'default' } : undefined}
    >
      {renderIcon()}
      <div className="dropdown-item-content">
        <div className="dropdown-item-label">{item.label}</div>
        {item.description && (
          <div className="dropdown-item-description">{item.description}</div>
        )}
      </div>
    </div>
  );
};

export default DropdownItem;
