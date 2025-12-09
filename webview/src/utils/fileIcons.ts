/**
 * 文件图标映射工具
 * 返回内联的 SVG 字符串，用于支持 vite-plugin-singlefile 打包
 */

import * as icons from './icons';

/**
 * 根据文件扩展名获取图标 SVG
 */
export function getFileIcon(extension?: string): string {
  if (!extension) {
    return icons.icon_file;
  }

  const ext = extension.toLowerCase();
  const iconMap: Record<string, string> = {
    // 编程语言 - 主流
    ts: icons.icon_typescript,
    tsx: icons.icon_typescript,
    js: icons.icon_javascript,
    jsx: icons.icon_javascript,
    py: icons.icon_python,
    java: icons.icon_java,
    go: icons.icon_go,
    rs: icons.icon_rust,
    php: icons.icon_php,
    c: icons.icon_c,
    cpp: icons.icon_cpp,
    cc: icons.icon_cpp,
    cxx: icons.icon_cpp,
    'c++': icons.icon_cpp,
    kt: icons.icon_kotlin,
    kts: icons.icon_kotlin,
    swift: icons.icon_swift,
    rb: icons.icon_ruby,

    // 标记语言
    html: icons.icon_html,
    htm: icons.icon_html,
    xml: icons.icon_xml,

    // 样式文件
    css: icons.icon_css,
    scss: icons.icon_css,
    sass: icons.icon_css,
    less: icons.icon_css,

    // 框架相关
    vue: icons.icon_vue,
    svelte: icons.icon_svelte,

    // 配置文件
    json: icons.icon_json,
    yaml: icons.icon_yaml,
    yml: icons.icon_yaml,

    // 文档
    md: icons.icon_markdown,
    markdown: icons.icon_markdown,

    // GraphQL
    graphql: icons.icon_graphql,
    gql: icons.icon_graphql,

    // Prisma
    prisma: icons.icon_prisma,
  };

  return iconMap[ext] || icons.icon_file;
}

/**
 * 根据文件夹名称获取图标 SVG
 */
export function getFolderIcon(folderName: string, isOpen: boolean = false): string {
  const name = folderName.toLowerCase();

  // 特殊文件夹映射
  const specialFolders: Record<string, string> = {
    src: icons.icon_folder_src,
    test: icons.icon_folder_test,
    tests: icons.icon_folder_test,
    __tests__: icons.icon_folder_test,
    config: icons.icon_folder_config,
    configs: icons.icon_folder_config,
    configuration: icons.icon_folder_config,
    docs: icons.icon_folder_docs,
    doc: icons.icon_folder_docs,
    documentation: icons.icon_folder_docs,
    public: icons.icon_folder_public,
    node_modules: icons.icon_folder_node,
    '.git': icons.icon_folder_git,
    api: icons.icon_folder_api,
    apis: icons.icon_folder_api,
    lib: icons.icon_folder_lib,
    libs: icons.icon_folder_lib,
    library: icons.icon_folder_lib,
    libraries: icons.icon_folder_lib,
  };

  // 打开状态的通用文件夹
  if (isOpen && !specialFolders[name]) {
    return icons.icon_folder_open;
  }

  return specialFolders[name] || icons.icon_folder;
}

/**
 * 获取工具/框架相关的图标 SVG
 */
export function getToolIcon(toolName: string): string {
  const tools: Record<string, string> = {
    // 版本控制
    git: icons.icon_git,

    // 容器与运维
    docker: icons.icon_docker,

    // 运行时
    node: icons.icon_nodejs,
    nodejs: icons.icon_nodejs,

    // 包管理
    npm: icons.icon_npm,

    // 前端框架
    react: icons.icon_react,
    vue: icons.icon_vue,
    angular: icons.icon_angular,
    svelte: icons.icon_svelte,
    next: icons.icon_next,
    nuxt: icons.icon_nuxt,

    // 构建工具
    webpack: icons.icon_webpack,
    vite: icons.icon_vitest, // Vitest 图标也可用于 Vite

    // 代码质量
    eslint: icons.icon_eslint,
    prettier: icons.icon_prettier,

    // 测试框架
    jest: icons.icon_jest,
    vitest: icons.icon_vitest,

    // 构建系统
    gradle: icons.icon_gradle,

    // 样式工具
    tailwind: icons.icon_tailwindcss,
    tailwindcss: icons.icon_tailwindcss,

    // ORM
    prisma: icons.icon_prisma,

    // GraphQL
    graphql: icons.icon_graphql,

    // 编辑器
    vscode: icons.icon_vscode,
  };

  return tools[toolName.toLowerCase()] || icons.icon_file;
}
