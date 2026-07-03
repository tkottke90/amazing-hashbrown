export async function getHealth(): Promise<{ status: string }> {
  const res = await fetch('/api/v1/health');
  return res.json();
}
