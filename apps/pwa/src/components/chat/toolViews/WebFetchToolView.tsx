export function WebFetchToolView({ input }: { input: Record<string, unknown> }) {
  const url = (input.url as string) || '?';
  let displayUrl = url;
  try {
    const parsed = new URL(url);
    displayUrl = parsed.hostname + parsed.pathname.slice(0, 30);
  } catch {
    // keep raw
  }

  return (
    <>
      <span className="text-cyan-400">Fetch</span>{' '}
      <span className="font-mono truncate">{displayUrl}</span>
    </>
  );
}
