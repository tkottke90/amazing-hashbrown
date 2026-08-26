export function wikiWriteForbiddenMessage(wikiId: string, allowedWikiId: string): string {
  return (
    `This workspace is restricted to writing wiki "${allowedWikiId}" — ` +
    `"${wikiId}" is not allowed here — use wiki "${allowedWikiId}" instead.`
  );
}
