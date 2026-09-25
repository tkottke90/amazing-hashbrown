import { buildDeleteConfirmMessage } from '@/pages/workspaces/delete-confirm-message';

enum TestTypes {
  UNIT = '[unit]',
}

const managed = { name: 'foo', location: '/data/projects/foo', managedLocation: true };
const unmanaged = { name: 'legacy', location: '/home/me/code/repo', managedLocation: false };
const clean = { dirty: false, ahead: 0 };

describe('buildDeleteConfirmMessage', () => {
  it(`warns that a managed directory is permanently deleted and names its path ${TestTypes.UNIT}`, () => {
    const message = buildDeleteConfirmMessage(managed, null);
    expect(message).toContain('Delete workspace "foo"?');
    expect(message).toContain('permanently deletes /data/projects/foo');
    expect(message).toContain('cannot be undone');
  });

  it(`tells the user an unmanaged directory will be kept, never that it will be deleted ${TestTypes.UNIT}`, () => {
    const message = buildDeleteConfirmMessage(unmanaged, null);
    expect(message).toContain('/home/me/code/repo');
    expect(message).toContain('will be kept on disk');
    expect(message).not.toContain('permanently deletes');
  });

  it(`adds no git warning when the repository has no local-only work ${TestTypes.UNIT}`, () => {
    expect(buildDeleteConfirmMessage(managed, clean)).not.toContain('⚠');
  });

  it(`warns about uncommitted changes ${TestTypes.UNIT}`, () => {
    const message = buildDeleteConfirmMessage(managed, { dirty: true, ahead: 0 });
    expect(message).toContain('⚠ This repository has uncommitted changes that will be lost.');
  });

  it(`warns about a single unpushed commit in the singular ${TestTypes.UNIT}`, () => {
    const message = buildDeleteConfirmMessage(managed, { dirty: false, ahead: 1 });
    expect(message).toContain('⚠ This repository has 1 unpushed commit that will be lost.');
  });

  it(`warns about several unpushed commits in the plural ${TestTypes.UNIT}`, () => {
    const message = buildDeleteConfirmMessage(managed, { dirty: false, ahead: 3 });
    expect(message).toContain('3 unpushed commits');
  });

  it(`combines uncommitted changes and unpushed commits into one warning ${TestTypes.UNIT}`, () => {
    const message = buildDeleteConfirmMessage(managed, { dirty: true, ahead: 2 });
    expect(message).toContain(
      '⚠ This repository has uncommitted changes and 2 unpushed commits that will be lost.',
    );
  });

  it(`never shows a git warning for an unmanaged workspace, since its files are untouched ${TestTypes.UNIT}`, () => {
    expect(buildDeleteConfirmMessage(unmanaged, { dirty: true, ahead: 5 })).not.toContain('⚠');
  });
});
