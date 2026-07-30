export function fairMergeBusinessIds(
  sources: ReadonlyArray<ReadonlyArray<string>>,
  limit: number,
  startingSource = 0,
) {
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (!safeLimit || !sources.length) return [];

  const sourceCount = sources.length;
  const normalizedStart = (
    (Math.trunc(startingSource) % sourceCount) + sourceCount
  ) % sourceCount;
  const cursors = sources.map(() => 0);
  const selected: string[] = [];
  const seen = new Set<string>();

  while (selected.length < safeLimit) {
    let consumedCandidate = false;

    for (let offset = 0; offset < sourceCount; offset += 1) {
      const sourceIndex = (normalizedStart + offset) % sourceCount;
      const source = sources[sourceIndex]!;

      while (cursors[sourceIndex]! < source.length) {
        const candidate = source[cursors[sourceIndex]!]!;
        cursors[sourceIndex]! += 1;
        consumedCandidate = true;
        if (seen.has(candidate)) continue;

        seen.add(candidate);
        selected.push(candidate);
        break;
      }

      if (selected.length >= safeLimit) break;
    }

    if (!consumedCandidate) break;
  }

  return selected;
}
