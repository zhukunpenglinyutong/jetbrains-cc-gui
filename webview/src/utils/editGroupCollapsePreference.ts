import { createCollapsePreference } from './collapsePreference';

export const EDIT_GROUP_COLLAPSED_KEY = 'editGroupCollapsedByDefault';

export const editGroupCollapsePreference = createCollapsePreference(
  EDIT_GROUP_COLLAPSED_KEY,
  'edit-group-collapsed-changed',
);
