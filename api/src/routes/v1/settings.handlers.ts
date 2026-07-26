export async function reloadSettingsHandler(
  config: { reload: () => void },
  loadAgentInstructions: () => Promise<void>,
  invalidateChatAgent: () => void,
  seedProviderCosts: () => void,
): Promise<{ status: 'ok' }> {
  config.reload();
  await loadAgentInstructions();
  invalidateChatAgent();
  seedProviderCosts();
  return { status: 'ok' };
}
