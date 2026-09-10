import React from "react";

/**
 * Button - OpenAI 风格的按钮组件
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - 按钮内容
 * @param {'primary'|'secondary'|'ghost'} [props.variant='primary'] - 按钮变体
 * @param {'sm'|'md'|'lg'} [props.size='md'] - 按钮尺寸
 * @param {function} [props.onClick] - 点击事件处理函数
 * @param {boolean} [props.disabled=false] - 是否禁用
 * @param {string} [props.className] - 额外的 CSS 类名
 * @param {React.ElementType} [props.as] - 渲染的元素类型
 */
const BASE_STYLES =
  "inline-flex items-center justify-center font-medium transition-all duration-200 rounded-md focus:outline-none focus:ring-2 focus:ring-oai-blue/30 active:scale-[0.98] active:duration-100";

const VARIANT_STYLES = {
  primary:
    "bg-oai-black dark:bg-oai-white text-white dark:text-oai-black border border-transparent hover:bg-oai-gray-800 dark:hover:bg-oai-gray-200 active:bg-oai-gray-900 dark:active:bg-oai-gray-300 disabled:bg-oai-gray-300 dark:disabled:bg-oai-gray-700 disabled:text-oai-gray-500 dark:disabled:text-oai-gray-400 focus:ring-oai-brand/30 transition-colors duration-200",
  secondary:
    "bg-oai-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white border border-oai-gray-300 dark:border-oai-gray-700 hover:border-oai-brand hover:text-oai-brand active:bg-oai-gray-50 dark:active:bg-oai-gray-800 active:border-oai-brand-dark disabled:text-oai-gray-400 dark:disabled:text-oai-gray-500 disabled:border-oai-gray-200 dark:disabled:border-oai-gray-700 focus:ring-oai-brand/30 transition-colors duration-200",
  ghost:
    "bg-transparent text-oai-gray-600 dark:text-oai-gray-300 border border-transparent hover:text-oai-brand hover:bg-oai-brand-50/50 dark:hover:bg-oai-brand-950/30 active:bg-oai-brand-50 dark:active:bg-oai-brand-900/50 disabled:text-oai-gray-400 dark:disabled:text-oai-gray-500 focus:ring-oai-brand/30 transition-colors duration-200",
};

const SIZE_STYLES = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  onClick,
  disabled = false,
  className = "",
  as: Component = "button",
  ...props
}) {
  const disabledStyles = disabled
    ? "cursor-not-allowed opacity-60"
    : "cursor-pointer";

  const mergedClassName = `${BASE_STYLES} ${VARIANT_STYLES[variant]} ${SIZE_STYLES[size]} ${disabledStyles} ${className}`;

  return (
    <Component
      className={mergedClassName}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </Component>
  );
}
