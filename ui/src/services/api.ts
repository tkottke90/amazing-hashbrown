export async function getHealth(): Promise<{ status: string }> {
  const res = await fetch('/api/health');
  return res.json();
}
