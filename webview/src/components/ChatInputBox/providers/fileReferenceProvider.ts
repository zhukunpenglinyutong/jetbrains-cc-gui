import type { FileItem, DropdownItemData } from '../types';
import { getFileIcon, getFolderIcon } from '../../../utils/fileIcons';
import { icon_terminal, icon_server } from '../../../utils/icons';

// 请求队列管理
let pendingResolve: ((files: FileItem[]) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;
let lastQuery: string = '';

/**
 * 重置文件引用提供者状态
 * 在组件初始化时调用，确保状态是干净的
 */
export function resetFileReferenceState() {
  console.log('[fileReferenceProvider] Resetting file reference state');
  pendingResolve = null;
  pendingReject = null;
  lastQuery = '';
}

/**
 * 注册 Java 回调
 */
function setupFileListCallback() {
  if (typeof window !== 'undefined' && !window.onFileListResult) {
    window.onFileListResult = (json: string) => {
      try {
        const data = JSON.parse(json);
        let files: FileItem[] = data.files || data || [];

        // 过滤掉应该隐藏的文件
        files = files.filter(file => !shouldHideFile(file.name));

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
 * 检查文件是否应该被隐藏（不显示在列表中）
 */
function shouldHideFile(fileName: string): boolean {
  // 隐藏的文件/文件夹列表
  const hiddenItems = [
    '.DS_Store',      // macOS 系统文件
    '.git',           // Git 仓库文件夹
    'node_modules',   // npm 依赖文件夹
    '.idea',          // IntelliJ IDEA 配置文件夹
  ];

  return hiddenItems.includes(fileName);
}

/**
 * 默认文件列表（当 Java 端未实现时返回空列表）
 */
const DEFAULT_FILES: FileItem[] = [];

/**
 * 过滤文件
 */
function filterFiles(files: FileItem[], query: string): FileItem[] {
  // 首先过滤掉应该隐藏的文件
  let filtered = files.filter(file => !shouldHideFile(file.name));

  // 如果有搜索关键词，再根据关键词过滤
  if (query) {
    const lowerQuery = query.toLowerCase();
    filtered = filtered.filter(file =>
      file.name.toLowerCase().includes(lowerQuery) ||
      file.path.toLowerCase().includes(lowerQuery)
    );
  }

  return filtered;
}

/**
 * 从查询字符串中提取当前路径和搜索关键词
 * 例如：
 *   "" → { currentPath: "", searchQuery: "" }
 *   "src/" → { currentPath: "src/", searchQuery: "" }
 *   "src/com" → { currentPath: "src/", searchQuery: "com" }
 *   "but" → { currentPath: "", searchQuery: "but" }
 */
function parseQuery(query: string): { currentPath: string; searchQuery: string } {
  if (!query) {
    return { currentPath: '', searchQuery: '' };
  }

  // 检查是否包含 / 符号
  const lastSlashIndex = query.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    // 没有斜杠，说明是在根目录搜索
    return { currentPath: '', searchQuery: query };
  }

  // 有斜杠，分离路径和搜索词
  const currentPath = query.substring(0, lastSlashIndex + 1);
  const searchQuery = query.substring(lastSlashIndex + 1);

  return { currentPath, searchQuery };
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

    // 解析查询：分离路径和搜索关键词
    const { currentPath, searchQuery } = parseQuery(query);

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
      const filtered = filterFiles(DEFAULT_FILES, searchQuery);
      pendingResolve = null;
      pendingReject = null;
      resolve(filtered);
      return;
    }

    // 发送请求，包含当前路径和搜索关键词
    sendToJava('list_files', {
      query: searchQuery,        // 搜索关键词
      currentPath: currentPath,  // 当前路径
    });

    // 超时处理（3秒），超时后使用默认文件列表
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        pendingReject = null;
        // 超时时返回过滤后的默认文件列表
        resolve(filterFiles(DEFAULT_FILES, searchQuery));
      }
    }, 3000);
  });
}

/**
 * 将 FileItem 转换为 DropdownItemData
 */
export function fileToDropdownItem(file: FileItem): DropdownItemData {
  let iconSvg: string;
  let type: 'directory' | 'file' | 'terminal' | 'service';

  if (file.type === 'terminal') {
    iconSvg = icon_terminal;
    type = 'terminal';
  } else if (file.type === 'service') {
    iconSvg = icon_server;
    type = 'service';
  } else if (file.type === 'directory') {
    iconSvg = getFolderIcon(file.name, false);
    type = 'directory';
  } else {
    iconSvg = getFileIcon(file.extension, file.name);
    type = 'file';
  }

  return {
    id: file.path,
    label: file.name,
    description: file.absolutePath || file.path, // 优先显示完整路径
    icon: iconSvg, // 直接使用 SVG 字符串
    type: type,
    data: { file },
  };
}

export default fileReferenceProvider;
