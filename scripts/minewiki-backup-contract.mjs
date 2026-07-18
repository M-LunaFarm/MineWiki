import path from 'node:path';

export function parseMysqlDatabaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    throw new Error('DATABASE_URL must be a valid mysql:// URL.');
  }
  if (url.protocol !== 'mysql:') throw new Error('MineWiki backups currently require a mysql:// DATABASE_URL.');
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!url.hostname || !database || !decodeURIComponent(url.username)) {
    throw new Error('DATABASE_URL must include a host, user, and database name.');
  }
  return {
    host: url.hostname,
    port: url.port || '3306',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

export function resolveSafeDirectory(value, { label, forbidden = [] }) {
  const resolved = path.resolve(String(value ?? '').trim());
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new Error(`${label} must be an absolute non-root directory.`);
  }
  for (const candidate of forbidden) {
    const blocked = path.resolve(candidate);
    if (resolved === blocked || blocked.startsWith(`${resolved}${path.sep}`) || resolved.startsWith(`${blocked}${path.sep}`)) {
      throw new Error(`${label} cannot contain ${blocked}.`);
    }
  }
  return resolved;
}

export function assertSafeArchiveEntries(entries) {
  for (const entry of entries) {
    const normalized = String(entry).replace(/\\/gu, '/');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`Unsafe upload archive entry: ${entry}`);
    }
  }
}

export function selectSnapshotsToDelete(snapshots, { now = new Date(), daily = 7, weekly = 4, monthly = 6 } = {}) {
  const sorted = [...snapshots]
    .filter((item) => item.verifiedAt)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const keep = new Set();
  const dailyKeys = new Set();
  const weeklyKeys = new Set();
  const monthlyKeys = new Set();
  for (const item of sorted) {
    const date = new Date(item.createdAt);
    const ageDays = Math.floor((now - date) / 86_400_000);
    const dayKey = date.toISOString().slice(0, 10);
    const monthKey = date.toISOString().slice(0, 7);
    const weekKey = `${date.getUTCFullYear()}-${isoWeek(date)}`;
    if (ageDays < daily && !dailyKeys.has(dayKey)) {
      dailyKeys.add(dayKey); keep.add(item.id); continue;
    }
    if (ageDays < daily + weekly * 7 && !weeklyKeys.has(weekKey)) {
      weeklyKeys.add(weekKey); keep.add(item.id); continue;
    }
    if (!monthlyKeys.has(monthKey) && monthlyKeys.size < monthly) {
      monthlyKeys.add(monthKey); keep.add(item.id);
    }
  }
  if (sorted[0]) keep.add(sorted[0].id);
  return sorted.filter((item) => !keep.has(item.id)).map((item) => item.id);
}

function isoWeek(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const start = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return String(Math.ceil((((target - start) / 86_400_000) + 1) / 7)).padStart(2, '0');
}
