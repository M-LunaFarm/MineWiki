import { fetchWikiSuggestions, type WikiSearchResult } from '../../lib/wiki-api';

let suggestionListSequence = 0;

export function hydrateWikiSearchSuggestions(root: HTMLElement): () => void {
  const forms = Array.from(
    root.querySelectorAll<HTMLFormElement>('.front-wiki-search .search-page[action="/search"]'),
  );
  const cleanups = forms.map((form) => hydrateSearchForm(form));
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function hydrateSearchForm(form: HTMLFormElement): () => void {
  const input = form.querySelector<HTMLInputElement>('input.search-page-input[name="q"]');
  if (!input) return () => undefined;

  suggestionListSequence += 1;
  const listId = `wiki-search-suggestions-${suggestionListSequence}`;
  const field = document.createElement('div');
  field.className = 'search-page-field';
  input.before(field);
  field.append(input);

  const results = document.createElement('div');
  results.id = listId;
  results.className = 'wiki-search-suggest-results front-wiki-search-suggest-results';
  results.setAttribute('role', 'listbox');
  results.setAttribute('aria-label', '위키 제목 제안');
  results.hidden = true;
  field.append(results);

  const previousAttributes = {
    role: input.getAttribute('role'),
    autocomplete: input.getAttribute('aria-autocomplete'),
    expanded: input.getAttribute('aria-expanded'),
    controls: input.getAttribute('aria-controls'),
    activeDescendant: input.getAttribute('aria-activedescendant'),
  };
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);

  let focused = false;
  let loading = false;
  let timer: number | null = null;
  let requestSequence = 0;
  let items: WikiSearchResult[] = [];
  let exactMatch: WikiSearchResult | null = null;
  let activeIndex = -1;

  const suggestions = () => {
    if (!exactMatch) return items;
    return [exactMatch, ...items.filter((item) => item.pageId !== exactMatch?.pageId)];
  };

  const updateActiveOption = () => {
    const options = Array.from(results.querySelectorAll<HTMLElement>('[role="option"]'));
    options.forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === activeIndex));
    });
    if (activeIndex >= 0 && options[activeIndex]) {
      input.setAttribute('aria-activedescendant', options[activeIndex].id);
      options[activeIndex].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const render = () => {
    const query = input.value.trim();
    const open = focused && query.length > 0;
    results.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    results.replaceChildren();
    if (!open) return;

    suggestions().forEach((item, index) => {
      const option = document.createElement('a');
      option.id = `${listId}-${index}`;
      option.href = item.routePath;
      option.className = 'wiki-search-suggest-result front-wiki-search-suggest-result';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(activeIndex === index));

      const titleRow = document.createElement('span');
      titleRow.className = 'front-wiki-search-suggest-title';
      const title = document.createElement('span');
      title.className = 'front-wiki-search-suggest-title-text';
      title.textContent = item.displayTitle;
      titleRow.append(title);
      if (exactMatch?.pageId === item.pageId) {
        const badge = document.createElement('span');
        badge.className = 'wiki-search-suggest-badge front-wiki-search-suggest-badge';
        badge.textContent = '제목 일치';
        titleRow.append(badge);
      }

      const meta = document.createElement('span');
      meta.className = 'wiki-search-suggest-meta front-wiki-search-suggest-meta';
      meta.textContent = `${item.namespace}:${item.title}`;
      option.append(titleRow, meta);
      option.addEventListener('mouseenter', () => {
        activeIndex = index;
        updateActiveOption();
      });
      results.append(option);
    });

    if (loading) {
      results.append(buildStatus('문서 제목 찾는 중...'));
    } else if (suggestions().length === 0) {
      results.append(buildStatus('제목 일치 없음 · Enter로 내용 검색'));
    }

    if (exactMatch) {
      const hint = document.createElement('p');
      hint.className = 'wiki-search-suggest-hint front-wiki-search-suggest-hint';
      hint.textContent = 'Enter를 누르면 정확히 일치하는 문서로 바로 이동합니다.';
      results.append(hint);
    }
  };

  const scheduleSuggestions = () => {
    if (timer !== null) window.clearTimeout(timer);
    requestSequence += 1;
    const currentRequest = requestSequence;
    activeIndex = -1;
    items = [];
    exactMatch = null;
    const query = input.value.trim();
    if (!focused || !query) {
      loading = false;
      render();
      return;
    }
    loading = true;
    render();
    timer = window.setTimeout(() => {
      void fetchWikiSuggestions(query)
        .then((response) => {
          if (currentRequest !== requestSequence) return;
          items = response.items;
          exactMatch = response.exactMatch;
          activeIndex = -1;
        })
        .catch(() => {
          if (currentRequest !== requestSequence) return;
          items = [];
          exactMatch = null;
        })
        .finally(() => {
          if (currentRequest !== requestSequence) return;
          loading = false;
          render();
        });
    }, 100);
  };

  const onFocus = () => {
    focused = true;
    scheduleSuggestions();
  };
  const onInput = () => scheduleSuggestions();
  const onBlur = (event: FocusEvent) => {
    if (results.contains(event.relatedTarget as Node | null)) return;
    focused = false;
    activeIndex = -1;
    render();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const available = suggestions();
    if (event.key === 'ArrowDown' && available.length > 0) {
      event.preventDefault();
      activeIndex = activeIndex >= available.length - 1 ? 0 : activeIndex + 1;
      updateActiveOption();
    } else if (event.key === 'ArrowUp' && available.length > 0) {
      event.preventDefault();
      activeIndex = activeIndex <= 0 ? available.length - 1 : activeIndex - 1;
      updateActiveOption();
    } else if (event.key === 'Escape') {
      focused = false;
      activeIndex = -1;
      render();
      input.blur();
    }
  };
  const onSubmit = (event: SubmitEvent) => {
    const available = suggestions();
    const selected = activeIndex >= 0 ? available[activeIndex] : exactMatch;
    if (!selected) return;
    event.preventDefault();
    window.location.assign(selected.routePath);
  };
  const keepInputFocused = (event: MouseEvent) => event.preventDefault();

  input.addEventListener('focus', onFocus);
  input.addEventListener('input', onInput);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKeyDown);
  form.addEventListener('submit', onSubmit);
  results.addEventListener('mousedown', keepInputFocused);

  return () => {
    requestSequence += 1;
    if (timer !== null) window.clearTimeout(timer);
    input.removeEventListener('focus', onFocus);
    input.removeEventListener('input', onInput);
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('keydown', onKeyDown);
    form.removeEventListener('submit', onSubmit);
    results.removeEventListener('mousedown', keepInputFocused);
    restoreAttribute(input, 'role', previousAttributes.role);
    restoreAttribute(input, 'aria-autocomplete', previousAttributes.autocomplete);
    restoreAttribute(input, 'aria-expanded', previousAttributes.expanded);
    restoreAttribute(input, 'aria-controls', previousAttributes.controls);
    restoreAttribute(input, 'aria-activedescendant', previousAttributes.activeDescendant);
    field.before(input);
    field.remove();
  };
}

function buildStatus(message: string): HTMLParagraphElement {
  const status = document.createElement('p');
  status.className = 'wiki-search-suggest-meta front-wiki-search-suggest-status';
  status.setAttribute('role', 'status');
  status.textContent = message;
  return status;
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
