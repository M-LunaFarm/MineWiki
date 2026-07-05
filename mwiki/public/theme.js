const root = document.documentElement;
const storageKey = 'minewiki-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    return localStorage.getItem(storageKey) || 'system';
  } catch {
    return 'system';
  }
}

function systemTheme() {
  return darkQuery.matches ? 'dark' : 'light';
}

function resolvedTheme(value = storedTheme()) {
  return value === 'dark' || value === 'light' ? value : systemTheme();
}

function applyTheme(value = storedTheme()) {
  const theme = resolvedTheme(value);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#15191f' : '#00a495');
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    button.setAttribute('title', theme === 'dark' ? '라이트모드 전환' : '다크모드 전환');
  }
}

function nextTheme() {
  return resolvedTheme() === 'dark' ? 'light' : 'dark';
}

applyTheme();

darkQuery.addEventListener('change', () => {
  if (storedTheme() === 'system') applyTheme('system');
});

document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-theme-toggle]');
  if (!button) return;
  const theme = nextTheme();
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Non-persistent private contexts still get the current-page theme update.
  }
  applyTheme(theme);
});
