export function selectServerRecommendations({
  currentServerId,
  ranked = [],
  fallback = [],
  limit = 4,
}) {
  const selected = [];
  const seen = new Set([currentServerId]);

  for (const server of ranked) {
    if (!server?.id || seen.has(server.id) || selected.length >= limit) continue;
    seen.add(server.id);
    selected.push(server);
  }

  for (const server of fallback) {
    if (!server?.id || seen.has(server.id) || selected.length >= limit) continue;
    seen.add(server.id);
    selected.push({ ...server, rank: null });
  }

  return selected;
}
