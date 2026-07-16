export function matchCommonLines(oldLines: readonly string[], newLines: readonly string[]): Array<readonly [number, number]> {
  if (oldLines.length === 0 || newLines.length === 0) return [];
  return oldLines.length * newLines.length <= 2_000_000
    ? longestCommonLineMatches(oldLines, newLines)
    : monotonicLineMatches(oldLines, newLines);
}

function longestCommonLineMatches(oldLines: readonly string[], newLines: readonly string[]): Array<readonly [number, number]> {
  const rows = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      rows[oldIndex]![newIndex] = oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ? rows[oldIndex - 1]![newIndex - 1]! + 1
        : Math.max(rows[oldIndex - 1]![newIndex]!, rows[oldIndex]![newIndex - 1]!);
    }
  }
  const matches: Array<readonly [number, number]> = [];
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  while (oldIndex > 0 && newIndex > 0) {
    if (oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
      matches.push([oldIndex - 1, newIndex - 1]);
      oldIndex -= 1;
      newIndex -= 1;
    } else if (rows[oldIndex - 1]![newIndex]! >= rows[oldIndex]![newIndex - 1]!) {
      oldIndex -= 1;
    } else {
      newIndex -= 1;
    }
  }
  return matches.reverse();
}

function monotonicLineMatches(oldLines: readonly string[], newLines: readonly string[]): Array<readonly [number, number]> {
  const oldPositions = new Map<string, number[]>();
  oldLines.forEach((line, index) => oldPositions.set(line, [...(oldPositions.get(line) ?? []), index]));
  const matches: Array<readonly [number, number]> = [];
  let previousOldIndex = -1;
  for (let newIndex = 0; newIndex < newLines.length; newIndex += 1) {
    const candidate = oldPositions.get(newLines[newIndex]!)?.find((index) => index > previousOldIndex);
    if (candidate === undefined) continue;
    matches.push([candidate, newIndex]);
    previousOldIndex = candidate;
  }
  return matches;
}
