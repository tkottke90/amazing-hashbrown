export function Markdown({ children, className }: { children: string; className?: string }) {
  return <div className={`prose ${className ?? ''}`.trim()}>{children}</div>;
}
