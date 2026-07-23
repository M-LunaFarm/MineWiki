import type { CSSProperties } from 'react';

type Rgb = readonly [number, number, number];

function parseHex(value: string | null | undefined): Rgb {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^#[0-9a-f]{6}$/.test(normalized)) return [52, 109, 219];
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function mix(color: Rgb, target: Rgb, amount: number): Rgb {
  return color.map((channel, index) => channel + ((target[index] ?? 0) - channel) * amount) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

function contrast(first: Rgb, second: Rgb): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(color: Rgb, surface: Rgb, target: Rgb): Rgb {
  if (contrast(color, surface) >= 4.5) return color;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 18; index += 1) {
    const middle = (low + high) / 2;
    if (contrast(mix(color, target, middle), surface) >= 4.5) high = middle;
    else low = middle;
  }
  return mix(color, target, high);
}

function readableForeground(background: Rgb): string {
  const white: Rgb = [255, 255, 255];
  const ink: Rgb = [7, 16, 11];
  return contrast(white, background) >= contrast(ink, background) ? '#ffffff' : '#07100b';
}

export function serverWikiThemeStyle(accentColor?: string | null): CSSProperties {
  const accent = parseHex(accentColor);
  const lightAccent = ensureContrast(accent, parseHex('#ffffff'), [0, 0, 0]);
  const darkAccent = ensureContrast(accent, parseHex('#0b1118'), [255, 255, 255]);
  return {
    '--server-wiki-accent-light': toHex(lightAccent),
    '--server-wiki-accent-dark': toHex(darkAccent),
    '--server-wiki-accent-foreground-light': readableForeground(lightAccent),
    '--server-wiki-accent-foreground-dark': readableForeground(darkAccent),
  } as CSSProperties;
}
