import { describe, expect, it } from 'vitest';
import { projectNativeSkills } from './nativeSkillCatalog';

describe('native skills settings inventory', () => {
  it('keeps duplicate names, native paths and disabled status in the editable list', () => {
    const config = projectNativeSkills([
      { name: 'review', path: 'C:/user/SKILL.md', scope: 'user', enabled: true },
      { name: 'review', path: 'C:/repo/SKILL.md', scope: 'repo', enabled: false },
      { name: 'invalid-no-path' },
    ]);
    expect(Object.values(config.user!)).toHaveLength(1);
    expect(Object.values(config.repo!)[0]).toMatchObject({ name: 'review', enabled: false, skillPath: 'C:/repo/SKILL.md' });
    expect(Object.values(config.repo!)[0].id).not.toBe(Object.values(config.user!)[0].id);
  });
});
