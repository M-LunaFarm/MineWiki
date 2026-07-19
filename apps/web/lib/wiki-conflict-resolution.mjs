const START = '<<<<<<< 내 편집';
const BASE = '||||||| 기준 판';
const DIVIDER = '=======';
const END = '>>>>>>> 최신 판';

export function parseWikiConflictDocument(contentRaw) {
  const normalized = String(contentRaw ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const conflicts = [];
  for (let line = 0; line < lines.length; line += 1) {
    if (lines[line] !== START) continue;
    const startLine = line;
    const baseLine = findMarker(lines, BASE, startLine + 1);
    const dividerLine = findMarker(lines, DIVIDER, baseLine + 1);
    const endLine = findMarker(lines, END, dividerLine + 1);
    if (baseLine < 0 || dividerLine < 0 || endLine < 0) return [];
    conflicts.push({
      index: conflicts.length,
      startLine,
      endLine,
      local: lines.slice(startLine + 1, baseLine).join('\n'),
      base: lines.slice(baseLine + 1, dividerLine).join('\n'),
      current: lines.slice(dividerLine + 1, endLine).join('\n'),
    });
    line = endLine;
  }
  return conflicts;
}

export function resolveWikiConflict(contentRaw, conflictIndex, choice) {
  const normalized = String(contentRaw ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const conflict = parseWikiConflictDocument(normalized)[conflictIndex];
  if (!conflict) return normalized;
  const replacement = conflictChoice(conflict, choice);
  return [
    ...lines.slice(0, conflict.startLine),
    ...replacement.split('\n'),
    ...lines.slice(conflict.endLine + 1),
  ].join('\n');
}

export function resolveAllWikiConflicts(contentRaw, choice) {
  let resolved = String(contentRaw ?? '').replace(/\r\n?/g, '\n');
  while (parseWikiConflictDocument(resolved).length > 0) {
    resolved = resolveWikiConflict(resolved, 0, choice);
  }
  return resolved;
}

function conflictChoice(conflict, choice) {
  if (choice === 'local') return conflict.local;
  if (choice === 'base') return conflict.base;
  if (choice === 'current') return conflict.current;
  if (choice === 'both') {
    if (!conflict.local) return conflict.current;
    if (!conflict.current || conflict.current === conflict.local) return conflict.local;
    return `${conflict.local}\n${conflict.current}`;
  }
  throw new Error('Unknown wiki conflict resolution choice.');
}

function findMarker(lines, marker, start) {
  if (start <= 0) return -1;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index] === START) return -1;
    if (lines[index] === marker) return index;
  }
  return -1;
}
