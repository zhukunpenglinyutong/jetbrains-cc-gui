import type { FileItem, DropdownItemData } from '../types';

// 请求队列管理
let pendingResolve: ((files: FileItem[]) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;
let lastQuery: string = '';

/**
 * 注册 Java 回调
 */
function setupFileListCallback() {
  if (typeof window !== 'undefined' && !window.onFileListResult) {
    window.onFileListResult = (json: string) => {
      try {
        const data = JSON.parse(json);
        const files: FileItem[] = data.files || data || [];
        const result = files.length > 0 ? files : filterFiles(DEFAULT_FILES, lastQuery);
        pendingResolve?.(result);
      } catch (error) {
        console.error('[fileReferenceProvider] Parse error:', error);
        pendingReject?.(error as Error);
      } finally {
        pendingResolve = null;
        pendingReject = null;
      }
    };
  }
}

/**
 * 发送请求到 Java
 */
function sendToJava(event: string, payload: Record<string, unknown>) {
  if (window.sendToJava) {
    window.sendToJava(`${event}:${JSON.stringify(payload)}`);
  } else {
    console.warn('[fileReferenceProvider] sendToJava not available');
  }
}

/**
 * 默认文件列表（演示用，当 Java 端未实现时显示）
 */
const DEFAULT_FILES: FileItem[] = [
  { name: 'src', path: 'src', type: 'directory' },
  { name: 'package.json', path: 'package.json', type: 'file', extension: 'json' },
  { name: 'README.md', path: 'README.md', type: 'file', extension: 'md' },
  { name: 'tsconfig.json', path: 'tsconfig.json', type: 'file', extension: 'json' },
  { name: '.gitignore', path: '.gitignore', type: 'file' },
];

/**
 * 过滤文件
 */
function filterFiles(files: FileItem[], query: string): FileItem[] {
  if (!query) return files;

  const lowerQuery = query.toLowerCase();
  return files.filter(file =>
    file.name.toLowerCase().includes(lowerQuery) ||
    file.path.toLowerCase().includes(lowerQuery)
  );
}

/**
 * 文件引用数据提供者
 */
export async function fileReferenceProvider(
  query: string,
  signal: AbortSignal
): Promise<FileItem[]> {
  // 检查是否被取消
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // 设置回调
  setupFileListCallback();

  return new Promise((resolve, reject) => {
    // 检查是否被取消
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    // 保存回调
    pendingResolve = resolve;
    pendingReject = reject;
    lastQuery = query;

    // 监听取消信号
    signal.addEventListener('abort', () => {
      pendingResolve = null;
      pendingReject = null;
      reject(new DOMException('Aborted', 'AbortError'));
    });

    // 检查 sendToJava 是否可用
    if (!window.sendToJava) {
      // 使用默认文件列表进行本地过滤
      const filtered = filterFiles(DEFAULT_FILES, query);
      pendingResolve = null;
      pendingReject = null;
      resolve(filtered);
      return;
    }

    // 发送请求
    sendToJava('list_files', { query });

    // 超时处理（3秒），超时后使用默认文件列表
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        pendingReject = null;
        // 超时时返回过滤后的默认文件列表
        resolve(filterFiles(DEFAULT_FILES, query));
      }
    }, 3000);
  });
}

/**
 * 将 FileItem 转换为 DropdownItemData
 */
export function fileToDropdownItem(file: FileItem): DropdownItemData {
  const icon = file.type === 'directory'
    ? 'codicon-folder'
    : getFileIcon(file.extension);

  return {
    id: file.path,
    label: file.name,
    description: file.path,
    icon,
    type: file.type === 'directory' ? 'directory' : 'file',
    data: { file },
  };
}

/**
 * 根据扩展名获取文件图标
 */
function getFileIcon(extension?: string): string {
  if (!extension) return 'codicon-file';

  const iconMap: Record<string, string> = {
    // 编程语言
    ts: 'codicon-file-code',
    tsx: 'codicon-file-code',
    js: 'codicon-file-code',
    jsx: 'codicon-file-code',
    py: 'codicon-file-code',
    java: 'codicon-file-code',
    c: 'codicon-file-code',
    cpp: 'codicon-file-code',
    h: 'codicon-file-code',
    hpp: 'codicon-file-code',
    go: 'codicon-file-code',
    rs: 'codicon-file-code',
    rb: 'codicon-file-code',
    php: 'codicon-file-code',
    swift: 'codicon-file-code',
    kt: 'codicon-file-code',
    scala: 'codicon-file-code',
    // 标记语言
    html: 'codicon-file-code',
    css: 'codicon-file-code',
    scss: 'codicon-file-code',
    less: 'codicon-file-code',
    xml: 'codicon-file-code',
    svg: 'codicon-file-media',
    // 配置文件
    json: 'codicon-json',
    yaml: 'codicon-file-code',
    yml: 'codicon-file-code',
    toml: 'codicon-file-code',
    ini: 'codicon-settings-gear',
    // 文档
    md: 'codicon-markdown',
    txt: 'codicon-file-text',
    pdf: 'codicon-file-pdf',
    doc: 'codicon-file-text',
    docx: 'codicon-file-text',
    // 图片
    png: 'codicon-file-media',
    jpg: 'codicon-file-media',
    jpeg: 'codicon-file-media',
    gif: 'codicon-file-media',
    webp: 'codicon-file-media',
    ico: 'codicon-file-media',
  };

  return iconMap[extension.toLowerCase()] || 'codicon-file';
}

export default fileReferenceProvider;
