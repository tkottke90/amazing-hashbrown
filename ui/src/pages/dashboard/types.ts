interface WidgetBase {
  id: string;
  type: string; // discriminant; narrowed to a literal by each concrete variant
  title: string;
  subtitle?: string;
}

export interface MarkdownWidget extends WidgetBase {
  type: 'markdown';
  content: string; // markdown source
}

export type DashboardWidget = MarkdownWidget;
// Future slices add: | BigNumberWidget | LineGraphWidget | PieGraphWidget
