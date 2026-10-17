export interface CsvBodyData {
  labels: string[];
  values: number[];
}

/**
 * Best-effort client-side parse of a Line/Pie Graph widget's CSV Body, for
 * rendering only. Real validation already happened server-side at save
 * time (`validateWidgetRaw`), so this isn't a second source of truth for
 * validity — an unparseable row is just skipped rather than surfaced as an
 * error, and the first line is always treated as the header and dropped.
 */
export function parseCsvBody(raw: string): CsvBodyData {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const labels: string[] = [];
  const values: number[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length !== 2) continue;
    const [labelText, valueText] = parts as [string, string];
    const value = Number(valueText.trim());
    if (!Number.isFinite(value)) continue;
    labels.push(labelText.trim());
    values.push(value);
  }
  return { labels, values };
}
