import { activeGuard, confirmNavigateAway } from '@/hooks/use-settings-guard';

describe('confirmNavigateAway', () => {
  afterEach(() => {
    activeGuard.value = null;
    jest.restoreAllMocks();
  });

  it('returns true and does not call confirm() when nothing is registered', () => {
    const confirmSpy = jest.spyOn(window, 'confirm');

    expect(confirmNavigateAway()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('returns true and does not call confirm() when the registered guard is clean', () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    const discard = jest.fn();
    activeGuard.value = { isDirty: false, discard };

    expect(confirmNavigateAway()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it('confirms, discards, and returns true when dirty and the user accepts', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const discard = jest.fn();
    activeGuard.value = { isDirty: true, discard };

    expect(confirmNavigateAway()).toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?');
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('returns false and does not discard when dirty and the user cancels', () => {
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    const discard = jest.fn();
    activeGuard.value = { isDirty: true, discard };

    expect(confirmNavigateAway()).toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });
});
