import { useDashboardWidgets } from '@/pages/dashboard/use-dashboard-widgets';

describe('useDashboardWidgets', () => {
  it('returns a non-empty array of at least 3 widgets [unit]', () => {
    expect(useDashboardWidgets().length).toBeGreaterThanOrEqual(3);
  });

  it('returns widgets with unique ids [unit]', () => {
    const widgets = useDashboardWidgets();
    const ids = new Set(widgets.map((w) => w.id));
    expect(ids.size).toBe(widgets.length);
  });

  it('returns widgets that are all type "markdown" with required fields [unit]', () => {
    for (const widget of useDashboardWidgets()) {
      expect(widget.type).toBe('markdown');
      expect(widget.title.length).toBeGreaterThan(0);
      expect(typeof widget.content).toBe('string');
    }
  });

  it('is deterministic across calls [unit]', () => {
    expect(useDashboardWidgets()).toEqual(useDashboardWidgets());
  });
});
