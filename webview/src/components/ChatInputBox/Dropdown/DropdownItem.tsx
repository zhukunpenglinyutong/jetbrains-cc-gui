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
   * 获取图标类名
   */
  const getIconClass = (): string => {
    if (item.icon) return item.icon;

    switch (item.type) {
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
      <span className={`dropdown-item-icon codicon ${getIconClass()}`} />
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
