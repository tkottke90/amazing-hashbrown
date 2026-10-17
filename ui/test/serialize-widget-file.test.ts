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

  it(`writes a big-number widget with value/unit in frontmatter and no body ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Count',
      type: 'big-number',
      order: 0,
      value: 5,
      unit: 'things',
    });
    expect(raw).toContain('value: 5');
    expect(raw).toContain('unit: "things"');
    expect(raw.endsWith('---\n\n')).toBe(true);
  });

  it(`omits value/unit lines entirely when absent ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({ title: 'Count', type: 'big-number', order: 0 });
    expect(raw).not.toContain('value:');
    expect(raw).not.toContain('unit:');
  });

  it(`writes a line-graph widget's CSV Body as the file body ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Response time',
      type: 'line-graph',
      order: 0,
      data: 'label,value\n09:00,120',
      color: '#ff0000',
    });
    expect(raw).toContain('color: "#ff0000"');
    expect(raw.endsWith('---\n\nlabel,value\n09:00,120')).toBe(true);
  });

  it(`writes a pie-graph widget's colors override as a JSON array line ${TestTypes.UNIT}`, () => {
    const raw = serializeWidgetFile({
      title: 'Agent usage',
      type: 'pie-graph',
      order: 0,
      data: 'label,value\nQuery,30',
      colors: ['#111111', '#222222'],
    });
    expect(raw).toContain('colors: ["#111111","#222222"]');
    expect(raw.endsWith('---\n\nlabel,value\nQuery,30')).toBe(true);
  });
});
