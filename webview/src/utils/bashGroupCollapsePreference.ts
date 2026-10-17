import { createCollapsePreference } from './collapsePreference';

export const BASH_GROUP_COLLAPSED_KEY = 'bashGroupCollapsedByDefault';

export const bashGroupCollapsePreference = createCollapsePreference(
  BASH_GROUP_COLLAPSED_KEY,
  'bash-group-collapsed-changed',
);
