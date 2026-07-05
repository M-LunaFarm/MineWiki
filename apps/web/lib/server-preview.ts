const SERVER_PREVIEW_FALLBACK_BACKGROUNDS = [
  'bg-gradient-to-br from-[#334155] via-[#1f2937] to-[#0b1220]',
  'bg-gradient-to-br from-[#164e63] via-[#1f2937] to-[#0b1220]',
  'bg-gradient-to-br from-[#14532d] via-[#1f2937] to-[#0b1220]',
  'bg-gradient-to-br from-[#312e81] via-[#1f2937] to-[#0b1220]',
  'bg-gradient-to-br from-[#4a044e] via-[#1f2937] to-[#0b1220]',
  'bg-gradient-to-br from-[#422006] via-[#1f2937] to-[#0b1220]',
] as const;

interface ServerPreviewSeedInput {
  readonly id?: string | null;
  readonly joinHost?: string | null;
  readonly name?: string | null;
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function getServerPreviewSeed(input: ServerPreviewSeedInput): string {
  const id = input.id?.trim();
  if (id) {
    return id;
  }

  const host = input.joinHost?.trim().toLowerCase();
  if (host) {
    return host;
  }

  const name = input.name?.trim();
  if (name) {
    return name;
  }

  return 'server';
}

export function getServerPreviewFallbackClass(seed: string): string {
  const normalized = seed.trim() || 'server';
  const hashed = hashSeed(normalized);
  return SERVER_PREVIEW_FALLBACK_BACKGROUNDS[hashed % SERVER_PREVIEW_FALLBACK_BACKGROUNDS.length];
}

export function getServerPreviewInitial(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    return 'S';
  }
  return normalized.slice(0, 1).toUpperCase();
}
