import { serializeWidgetFile } from '@/pages/dashboard/serialize-widget-file';

enum TestTypes {
  UNIT = '[unit]',
}

describe('serializeWidgetFile', () => {
  it(`writes title/type/order and the body as frontmatter + content ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Welcome',
      type: 'markdown',
      order: 0,
      content: '# Hello\n\nBody text.',
    });
    expect(raw).toBe(
      '---\ntitle: "Welcome"\ntype: "markdown"\norder: 0\n---\n\n# Hello\n\nBody text.',
    );
  });

  it(`omits the subtitle line entirely when subtitle is undefined ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Tip',
      type: 'markdown',
      order: 1,
      content: 'Body',
    });
    expect(raw).not.toContain('subtitle:');
  });

  it(`includes a quoted subtitle line when subtitle is set ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Tip',
      subtitle: 'Of the day',
      type: 'markdown',
      order: 1,
      content: 'Body',
    });
    expect(raw).toContain('subtitle: "Of the day"');
  });

  it(`escapes a title containing a colon and a quote into one valid YAML line ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Status: "done"',
      type: 'markdown',
      order: 0,
      content: 'Body',
    });
    expect(raw).toContain('title: "Status: \\"done\\""');
    expect(raw.split('\n')[1]).toBe('title: "Status: \\"done\\""');
  });

  it(`strips leading blank lines from the content before the body ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Tip',
      type: 'markdown',
      order: 0,
      content: '\n\nBody after blank lines',
    });
    expect(raw.endsWith('---\n\nBody after blank lines')).toBe(true);
  });
});
