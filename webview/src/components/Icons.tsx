/**
 * Unified SVG Icon Components
 * Replaces Codicon font icons with inline SVG for better control and consistency
 *
 * Style: stroke-width: 1.8, stroke-linecap: round, stroke-linejoin: round
 */

import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

// Helper to create icon component with consistent styling
const createIcon = (path: React.ReactNode, viewBox = '0 0 24 24') => {
  const Icon: React.FC<IconProps> = ({ size = 16, className, style }) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {path}
    </svg>
  );
  Icon.displayName = 'Icon';
  return Icon;
};

// ==================== Navigation & Actions ====================

export const BackIcon = createIcon(
  <>
    <path d="M19 12H5" />
    <path d="M12 19l-7-7 7-7" />
  </>
);

export const ForwardIcon = createIcon(
  <>
    <path d="M5 12h14" />
    <path d="M12 5l7 7-7 7" />
  </>
);

export const CloseIcon = createIcon(
  <>
    <path d="M18 6L6 18" />
    <path d="M6 6l12 12" />
  </>
);

export const CheckIcon = createIcon(<polyline points="20 6 9 17 4 12" />);

export const ChevronDownIcon = createIcon(<path d="M6 9l6 6 6-6" />);

export const ChevronUpIcon = createIcon(<path d="M18 15l-6-6-6 6" />);

export const ChevronLeftIcon = createIcon(<path d="M15 18l-6-6 6-6" />);

export const ChevronRightIcon = createIcon(<path d="M9 18l6-6-6-6" />);

export const ArrowUpIcon = createIcon(
  <>
    <path d="M12 19V5" />
    <path d="M5 12l7-7 7 7" />
  </>
);

export const ArrowDownIcon = createIcon(
  <>
    <path d="M12 5v14" />
    <path d="M19 12l-7 7-7-7" />
  </>
);

// ==================== Communication ====================

export const SendIcon = createIcon(
  <>
    <path d="M22 2L11 13" />
    <path d="M22 2l-7 20-4-9-9-4 20-7z" />
  </>
);

export const StopIcon = createIcon(<rect x="6" y="6" width="12" height="12" rx="2" />);

export const MessageIcon = createIcon(<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />);

export const ChatIcon = createIcon(
  <>
    <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
  </>
);

// ==================== Files & Folders ====================

export const FileIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
  </>
);

export const FileCodeIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M10 13l-2 2 2 2" />
    <path d="M14 13l2 2-2 2" />
  </>
);

export const FileTextIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
    <path d="M10 9H8" />
  </>
);

export const FolderIcon = createIcon(<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />);

export const SaveIcon = createIcon(
  <>
    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </>
);

// ==================== Edit & Tools ====================

export const EditIcon = createIcon(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
  </>
);

export const TrashIcon = createIcon(
  <>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </>
);

export const CopyIcon = createIcon(
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </>
);

export const PasteIcon = createIcon(
  <>
    <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </>
);

export const UndoIcon = createIcon(
  <>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
  </>
);

// Counter-clockwise rotate icon - for rewind button
export const RotateCounterClockwiseIcon = createIcon(
  <>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6.69 3L3 13" />
    <polyline points="3 7 3 13 9 13" />
  </>
);

export const RedoIcon = createIcon(
  <>
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 019-9 9 9 0 016 2.3L21 13" />
  </>
);

export const RefreshIcon = createIcon(
  <>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
  </>
);

export const AttachIcon = createIcon(
  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
);

// Upload with plus icon - for file upload button
export const UploadPlusIcon = createIcon(
  <>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </>
);

// Panel collapse icon - for collapsing status panel
export const PanelCollapseIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="15" x2="21" y2="15" />
    <polyline points="15 19 12 16 9 19" />
  </>
);

// ==================== Settings & Config ====================

export const SettingsIcon = createIcon(
  <>
    <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>
);

export const GearIcon = createIcon(
  <>
    <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>
);

export const SlidersIcon = createIcon(
  <>
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </>
);

// ==================== Status & Indicators ====================

export const CheckCircleIcon = createIcon(
  <>
    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </>
);

export const XCircleIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M15 9l-6 6" />
    <path d="M9 9l6 6" />
  </>
);

export const AlertIcon = createIcon(
  <>
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </>
);

export const InfoIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </>
);

export const HelpIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </>
);

export const LoadingIcon: React.FC<IconProps & { spinning?: boolean }> = ({
  size = 16,
  className,
  style,
  spinning = true,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{
      ...style,
      animation: spinning ? 'icon-spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite' : undefined,
      willChange: spinning ? 'transform' : undefined,
    }}
  >
    <path d="M21 12a9 9 0 11-6.219-8.56" />
  </svg>
);

export const SpinnerIcon = LoadingIcon;

// ==================== Search ====================

export const SearchIcon = createIcon(
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
  </>
);

export const FilterIcon = createIcon(
  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
);

export const ReplaceIcon = createIcon(
  <>
    <path d="M12 3v18" />
    <path d="M5 12l7-7 7 7" />
  </>
);

// ==================== Agent & Users ====================

export const UserIcon = createIcon(
  <>
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>
);

export const UsersIcon = createIcon(
  <>
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 00-3-3.87" />
    <path d="M16 3.13a4 4 0 010 7.75" />
  </>
);

export const RobotIcon = createIcon(
  <>
    <rect x="4" y="6" width="16" height="14" rx="3" />
    <circle cx="9" cy="13" r="1.2" />
    <circle cx="15" cy="13" r="1.2" />
    <path d="M9 17h6" />
    <path d="M12 6V3" />
    <circle cx="12" cy="2.5" r="1" />
  </>
);

export const AgentIcon = RobotIcon;

// ==================== Shield & Security ====================

export const ShieldIcon = createIcon(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);

export const ShieldCheckIcon = createIcon(
  <>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </>
);

export const LockIcon = createIcon(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0110 0v4" />
  </>
);

export const UnlockIcon = createIcon(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 019.9-1" />
  </>
);

// ==================== Layout & UI ====================

export const LayersIcon = createIcon(
  <>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </>
);

export const LayoutIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </>
);

export const GridIcon = createIcon(
  <>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
  </>
);

export const ListIcon = createIcon(
  <>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </>
);

export const MenuIcon = createIcon(
  <>
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </>
);

export const MoreIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>
);

export const MaximizeIcon = createIcon(
  <>
    <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
  </>
);

export const MinimizeIcon = createIcon(
  <>
    <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
  </>
);

// ==================== History & Time ====================

export const HistoryIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
    <line x1="3" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="21" y2="12" />
    <line x1="12" y1="3" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="21" />
  </>
);

export const ClockIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </>
);

export const CalendarIcon = createIcon(
  <>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </>
);

// ==================== Code & Development ====================

export const TerminalIcon = createIcon(
  <>
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
  </>
);

export const CodeIcon = createIcon(
  <>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </>
);

export const GitBranchIcon = createIcon(
  <>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 01-9 9" />
  </>
);

export const GitCommitIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="4" />
    <line x1="1.05" y1="12" x2="7" y2="12" />
    <line x1="17.01" y1="12" x2="22.96" y2="12" />
  </>
);

export const BugIcon = createIcon(
  <>
    <rect x="8" y="6" width="8" height="14" rx="4" />
    <path d="M19 10h2" />
    <path d="M3 10h2" />
    <path d="M19 6h1a2 2 0 012 2" />
    <path d="M2 8a2 2 0 012-2h1" />
    <path d="M19 14h2" />
    <path d="M3 14h2" />
  </>
);

export const DatabaseIcon = createIcon(
  <>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </>
);

export const ServerIcon = createIcon(
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </>
);

// ==================== Media & Display ====================

export const ImageIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </>
);

export const EyeIcon = createIcon(
  <>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </>
);

export const EyeOffIcon = createIcon(
  <>
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </>
);

export const DownloadIcon = createIcon(
  <>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </>
);

export const UploadIcon = createIcon(
  <>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </>
);

// ==================== Misc ====================

export const StarIcon = createIcon(
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
);

export const HeartIcon = createIcon(
  <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
);

export const BookmarkIcon = createIcon(
  <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
);

export const LinkIcon = createIcon(
  <>
    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
  </>
);

export const ExternalLinkIcon = createIcon(
  <>
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </>
);

export const GlobeIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
  </>
);

export const CloudIcon = createIcon(<path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />);

export const WifiIcon = createIcon(
  <>
    <path d="M5 12.55a11 11 0 0114.08 0" />
    <path d="M1.42 9a16 16 0 0121.16 0" />
    <path d="M8.53 16.11a6 6 0 016.95 0" />
    <line x1="12" y1="20" x2="12.01" y2="20" />
  </>
);

export const ZapIcon = createIcon(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />);

export const SparklesIcon = createIcon(
  <>
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
    <path d="M2 17l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </>
);

export const MagicIcon = SparklesIcon;

export const BrainIcon = createIcon(
  <>
    <path d="M9.5 2A2.5 2.5 0 0112 4.5v15a2.5 2.5 0 01-4.96.44 2.5 2.5 0 01-2.96-3.08 3 3 0 01-.34-5.58 2.5 2.5 0 011.32-4.24 2.5 2.5 0 011.98-3A2.5 2.5 0 019.5 2z" />
    <path d="M14.5 2A2.5 2.5 0 0012 4.5v15a2.5 2.5 0 004.96.44 2.5 2.5 0 002.96-3.08 3 3 0 00.34-5.58 2.5 2.5 0 00-1.32-4.24 2.5 2.5 0 00-1.98-3A2.5 2.5 0 0014.5 2z" />
  </>
);

export const LightbulbIcon = createIcon(
  <>
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14" />
  </>
);

export const TargetIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </>
);

export const HashIcon = createIcon(
  <>
    <line x1="4" y1="9" x2="20" y2="9" />
    <line x1="4" y1="15" x2="20" y2="15" />
    <line x1="10" y1="3" x2="8" y2="21" />
    <line x1="16" y1="3" x2="14" y2="21" />
  </>
);

export const AtSignIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94" />
  </>
);

export const DollarIcon = createIcon(
  <>
    <line x1="12" y1="1" x2="12" y2="23" />
    <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
  </>
);

export const PercentIcon = createIcon(
  <>
    <line x1="19" y1="5" x2="5" y2="19" />
    <circle cx="6.5" cy="6.5" r="2.5" />
    <circle cx="17.5" cy="17.5" r="2.5" />
  </>
);

export const PlusIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="16" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </>
);

export const MinusIcon = createIcon(<line x1="5" y1="12" x2="19" y2="12" />);

export const EyeDropperIcon = createIcon(
  <>
    <path d="M2 22l1-1h3l9-9" />
    <path d="M3 21v-3l9-9" />
    <path d="M14.5 5.5L18 2l4 4-3.5 3.5" />
    <path d="M12 8l4 4" />
    <path d="M2 2l20 20" />
  </>
);

export const PenIcon = createIcon(
  <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
);

export const ClipboardIcon = createIcon(
  <>
    <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </>
);

export const ClipboardCheckIcon = createIcon(
  <>
    <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    <path d="M9 14l2 2 4-4" />
  </>
);

export const TaskIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M8 12l3 3 5-5" />
  </>
);

export const SubtaskIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M8 12l3 3 5-5" />
  </>
);

export const DiffIcon = createIcon(
  <>
    <path d="M12 3v18" />
    <path d="M5 12h14" />
  </>
);

// Dual-column diff view icon — double brackets with center axis
export const DiffViewIcon = createIcon(
  <>
    <path d="M7 5H5v14h2" />
    <path d="M17 5h2v14h-2" />
    <path d="M10 9h4" />
    <path d="M10 15h4" />
    <path d="M12 5v14" />
  </>
);

// Keep-all / checklist icon — multiple lines with checkmarks
export const KeepAllIcon = createIcon(
  <>
    <path d="M9 6h10" />
    <path d="M9 12h10" />
    <path d="M9 18h10" />
    <polyline points="4 6 5.5 7.5 7.5 5.5" />
    <polyline points="4 12 5.5 13.5 7.5 11.5" />
    <polyline points="4 18 5.5 19.5 7.5 17.5" />
  </>
);

export const PlayIcon = createIcon(<polygon points="5 3 19 12 5 21 5 3" />);

export const PauseIcon = createIcon(
  <>
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </>
);

export const SkipIcon = createIcon(
  <>
    <polygon points="5 4 15 12 5 20 5 4" />
    <line x1="19" y1="5" x2="19" y2="19" />
  </>
);

export const RewindIcon = createIcon(
  <>
    <polygon points="11 19 2 12 11 5 11 19" />
    <polygon points="22 19 13 12 22 5 22 19" />
  </>
);

export const FastForwardIcon = createIcon(
  <>
    <polygon points="13 19 22 12 13 5 13 19" />
    <polygon points="2 19 11 12 2 5 2 19" />
  </>
);

export const VolumeIcon = createIcon(
  <>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
  </>
);

export const VolumeXIcon = createIcon(
  <>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </>
);

export const BellIcon = createIcon(
  <>
    <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 01-3.46 0" />
  </>
);

export const BellOffIcon = createIcon(
  <>
    <path d="M13.73 21a2 2 0 01-3.46 0" />
    <path d="M18.63 13A17.89 17.89 0 0118 8" />
    <path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14" />
    <path d="M18 8a6 6 0 00-9.33-5" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </>
);

export const PinIcon = createIcon(
  <>
    <path d="M15 4.5l-4 4L7 10l-1.5 1.5 7 7L14 17l2-4 4-4" />
    <path d="M9 15l-4.5 4.5" />
    <path d="M14.5 4L20 9.5" />
  </>
);

export const PinOffIcon = createIcon(
  <>
    <line x1="2" y1="2" x2="22" y2="22" />
    <path d="M12 17v5" />
    <path d="M9 10.5L5 21l6-3.5" />
    <path d="M15 5.5L21 16l-2.5 1.5" />
    <path d="M12 2v2" />
    <path d="M12 6l4 4" />
  </>
);

export const TagIcon = createIcon(
  <>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </>
);

export const TagsIcon = createIcon(
  <>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
    <line x1="11" y1="11" x2="11.01" y2="11" />
  </>
);

export const BookmarkFilledIcon = createIcon(
  <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" fill="currentColor" />
);

export const StarFilledIcon = createIcon(
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor" />
);

export const HeartFilledIcon = createIcon(
  <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" fill="currentColor" />
);

export const CircleIcon = createIcon(<circle cx="12" cy="12" r="10" />);

export const CircleFilledIcon = createIcon(<circle cx="12" cy="12" r="10" fill="currentColor" />);

export const SquareIcon = createIcon(<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />);

export const SquareFilledIcon = createIcon(<rect x="3" y="3" width="18" height="18" rx="2" ry="2" fill="currentColor" />);

export const TriangleIcon = createIcon(<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />);

export const DiamondIcon = createIcon(<rect x="4.5" y="4.5" width="15" height="15" rx="1" transform="rotate(45 12 12)" />);

// ==================== History Page Icons ====================

export const ChecklistIcon = createIcon(
  <>
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
  </>
);

export const CheckAllIcon = createIcon(
  <>
    <rect x="8" y="2" width="13" height="18" rx="2" />
    <path d="M4 6l2 2 4-4" />
    <path d="M4 12l2 2 4-4" />
    <path d="M4 18l2 2 4-4" />
  </>
);

export const ClearAllIcon = createIcon(
  <>
    <rect x="8" y="2" width="13" height="18" rx="2" />
    <path d="M4 7l4 4M8 7l-4 4" />
    <path d="M4 13l4 4M8 13l-4 4" />
  </>
);

export const SyncIcon: React.FC<IconProps & { spinning?: boolean }> = ({
  size = 16,
  className,
  style,
  spinning = false,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{
      ...style,
      animation: spinning ? 'icon-spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite' : undefined,
      willChange: spinning ? 'transform' : undefined,
    }}
  >
    <path d="M21 2v6h-6" />
    <path d="M3 12a9 9 0 0115.36-6.36L21 8" />
    <path d="M3 22v-6h6" />
    <path d="M21 12a9 9 0 01-15.36 6.36L3 16" />
  </svg>
);

// Export all icons as a map for convenience
export const Icons = {
  back: BackIcon,
  forward: ForwardIcon,
  close: CloseIcon,
  check: CheckIcon,
  chevronDown: ChevronDownIcon,
  chevronUp: ChevronUpIcon,
  chevronLeft: ChevronLeftIcon,
  chevronRight: ChevronRightIcon,
  arrowUp: ArrowUpIcon,
  arrowDown: ArrowDownIcon,
  send: SendIcon,
  stop: StopIcon,
  message: MessageIcon,
  chat: ChatIcon,
  file: FileIcon,
  fileCode: FileCodeIcon,
  fileText: FileTextIcon,
  folder: FolderIcon,
  save: SaveIcon,
  edit: EditIcon,
  trash: TrashIcon,
  copy: CopyIcon,
  paste: PasteIcon,
  undo: UndoIcon,
  redo: RedoIcon,
  refresh: RefreshIcon,
  rotateCounterClockwise: RotateCounterClockwiseIcon,
  attach: AttachIcon,
  settings: SettingsIcon,
  gear: GearIcon,
  sliders: SlidersIcon,
  checkCircle: CheckCircleIcon,
  xCircle: XCircleIcon,
  alert: AlertIcon,
  info: InfoIcon,
  help: HelpIcon,
  loading: LoadingIcon,
  spinner: SpinnerIcon,
  search: SearchIcon,
  filter: FilterIcon,
  replace: ReplaceIcon,
  user: UserIcon,
  users: UsersIcon,
  robot: RobotIcon,
  agent: AgentIcon,
  shield: ShieldIcon,
  shieldCheck: ShieldCheckIcon,
  lock: LockIcon,
  unlock: UnlockIcon,
  layers: LayersIcon,
  layout: LayoutIcon,
  grid: GridIcon,
  list: ListIcon,
  menu: MenuIcon,
  more: MoreIcon,
  maximize: MaximizeIcon,
  minimize: MinimizeIcon,
  history: HistoryIcon,
  clock: ClockIcon,
  calendar: CalendarIcon,
  terminal: TerminalIcon,
  code: CodeIcon,
  gitBranch: GitBranchIcon,
  gitCommit: GitCommitIcon,
  bug: BugIcon,
  database: DatabaseIcon,
  server: ServerIcon,
  image: ImageIcon,
  eye: EyeIcon,
  eyeOff: EyeOffIcon,
  download: DownloadIcon,
  upload: UploadIcon,
  star: StarIcon,
  heart: HeartIcon,
  bookmark: BookmarkIcon,
  link: LinkIcon,
  externalLink: ExternalLinkIcon,
  globe: GlobeIcon,
  cloud: CloudIcon,
  wifi: WifiIcon,
  zap: ZapIcon,
  sparkles: SparklesIcon,
  magic: MagicIcon,
  brain: BrainIcon,
  lightbulb: LightbulbIcon,
  target: TargetIcon,
  hash: HashIcon,
  atSign: AtSignIcon,
  dollar: DollarIcon,
  percent: PercentIcon,
  plus: PlusIcon,
  minus: MinusIcon,
  eyeDropper: EyeDropperIcon,
  pen: PenIcon,
  clipboard: ClipboardIcon,
  clipboardCheck: ClipboardCheckIcon,
  task: TaskIcon,
  subtask: SubtaskIcon,
  diff: DiffIcon,
  diffView: DiffViewIcon,
  keepAll: KeepAllIcon,
  play: PlayIcon,
  pause: PauseIcon,
  skip: SkipIcon,
  rewind: RewindIcon,
  fastForward: FastForwardIcon,
  volume: VolumeIcon,
  volumeX: VolumeXIcon,
  bell: BellIcon,
  bellOff: BellOffIcon,
  pin: PinIcon,
  pinOff: PinOffIcon,
  tag: TagIcon,
  tags: TagsIcon,
  bookmarkFilled: BookmarkFilledIcon,
  starFilled: StarFilledIcon,
  heartFilled: HeartFilledIcon,
  circle: CircleIcon,
  circleFilled: CircleFilledIcon,
  square: SquareIcon,
  squareFilled: SquareFilledIcon,
  triangle: TriangleIcon,
  diamond: DiamondIcon,
  checklist: ChecklistIcon,
  checkAll: CheckAllIcon,
  clearAll: ClearAllIcon,
  sync: SyncIcon,
} as const;

export type IconName = keyof typeof Icons;

// Helper component to render icon by name
export const Icon: React.FC<IconProps & { name: IconName }> = ({ name, ...props }) => {
  const IconComponent = Icons[name];
  return <IconComponent {...props} />;
};

export default Icons;
