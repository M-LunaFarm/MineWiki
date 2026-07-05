const forms = document.querySelectorAll('form.top-search, .home-search form, .front-search-component form, form.search-page, form.sidebar-search');

for (const form of forms) {
  const input = form.querySelector('input[name="q"]');
  if (!input) continue;
  const box = document.createElement('div');
  box.className = 'search-suggest-box';
  box.hidden = true;
  form.classList.add('search-suggest-root');
  form.append(box);

  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 1) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    timer = window.setTimeout(async () => {
      const params = new URLSearchParams(new FormData(form));
      params.set('q', q);
      const rows = await fetch(`/api/search/suggest?${params.toString()}`).then((res) => res.ok ? res.json() : []).catch(() => []);
      box.replaceChildren(...rows.slice(0, 6).map((row) => suggestItem(row)));
      box.hidden = rows.length === 0;
    }, 120);
  });

  form.addEventListener('submit', async (event) => {
    const q = input.value.trim();
    if (!q || form.dataset.noResolve === '1') return;
    event.preventDefault();
    const params = new URLSearchParams(new FormData(form));
    const resolved = await fetch(`/api/search/resolve?${params.toString()}`).then((res) => res.ok ? res.json() : null).catch(() => null);
    if (resolved?.action === 'redirect' && safeLocalUrl(resolved.target) === resolved.target) {
      window.location.href = resolved.target;
      return;
    }
    window.location.href = `${form.getAttribute('action') || '/search'}?${params.toString()}`;
  });

  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) box.hidden = true;
  });
}

function suggestItem(row) {
  const badge = row.spaceTitle || spaceLabel(row.namespace);
  const title = row.title || '';
  const description = row.match && row.match !== title ? row.match : matchTypeLabel(row.matchType);
  const item = document.createElement('a');
  item.className = 'search-suggest-item';
  item.href = safeLocalUrl(row.url || '/search');
  const badgeNode = document.createElement('span');
  badgeNode.textContent = badge;
  const titleNode = document.createElement('strong');
  titleNode.textContent = title;
  const descriptionNode = document.createElement('small');
  descriptionNode.textContent = description || '';
  item.append(badgeNode, titleNode, descriptionNode);
  return item;
}

function spaceLabel(namespace) {
  return { main: '위키', mod: '모드 위키', server: '서버 위키', dev: '개발', guide: '가이드' }[namespace] || namespace || '문서';
}

function matchTypeLabel(type) {
  return { title: '제목 일치', redirect: '넘겨주기', alias: '별칭', english: '영문명', korean_alt: '한국어명', common_query: '자주 찾는 문서', disambiguation: '동음이의 후보' }[type] || '';
}

function safeLocalUrl(value) {
  const url = String(value || '/search');
  return url.startsWith('/') && !url.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(url) ? url : '/search';
}
