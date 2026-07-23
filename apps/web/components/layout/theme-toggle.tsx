'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const THEME_EVENT = 'minewiki:theme-change';

function resolveTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem('minewiki-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme: Theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (persist) window.localStorage.setItem('minewiki-theme', theme);
}

export function ThemeToggle({ paper = false }: { readonly paper?: boolean }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const resolved = resolveTheme();
    applyTheme(resolved);
    setTheme(resolved);

    const media = window.matchMedia('(prefers-color-scheme: light)');
    const synchronize = () => {
      const next = resolveTheme();
      applyTheme(next);
      setTheme(next);
    };
    const handleThemeEvent = (event: Event) => {
      const next = (event as CustomEvent<Theme>).detail;
      if (next === 'light' || next === 'dark') setTheme(next);
    };
    const handleMediaChange = () => {
      if (!window.localStorage.getItem('minewiki-theme')) synchronize();
    };
    window.addEventListener('storage', synchronize);
    window.addEventListener(THEME_EVENT, handleThemeEvent);
    media.addEventListener('change', handleMediaChange);
    return () => {
      window.removeEventListener('storage', synchronize);
      window.removeEventListener(THEME_EVENT, handleThemeEvent);
      media.removeEventListener('change', handleMediaChange);
    };
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
    setTheme(next);
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: next }));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border transition ${
        paper
          ? 'border-[#aaa79e] bg-white/30 text-[#343a34] hover:bg-white/55'
          : 'border-white/[0.08] bg-white/[0.03] text-slate-300 hover:border-white/20 hover:text-white'
      }`}
      aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
      title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
    >
      {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}
