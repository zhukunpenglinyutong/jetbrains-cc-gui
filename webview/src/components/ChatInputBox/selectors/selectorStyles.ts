/**
 * Shared inline styles for the ConfigSelect dropdown rows and the extracted
 * menu-item components (AgentMenuItem, RuntimeProviderMenuItem,
 * NodeProcessesMenuItem, OfficialDocsOption).
 */
export const SELECTOR_OPTION_RELATIVE_STYLE: React.CSSProperties = { position: 'relative', overflow: 'visible' };

export const ITEM_INFO_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
};

export const ARROW_CONTAINER_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  alignSelf: 'stretch',
  paddingLeft: '12px',
  cursor: 'pointer',
};

export const ARROW_ICON_STYLE: React.CSSProperties = { fontSize: '12px' };

export const AGENT_DESC_PLAIN_STYLE: React.CSSProperties = {
  fontStyle: 'normal',
};
