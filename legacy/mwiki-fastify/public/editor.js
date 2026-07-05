const textarea = document.querySelector('#content');
const preview = document.querySelector('#preview');
const formEditor = document.querySelector('[data-form-editor]');
const formSelect = document.querySelector('[data-component-form]');
const formFields = document.querySelector('[data-component-fields]');
const tabButtons = document.querySelectorAll('[data-editor-tab]');
const tabPanes = document.querySelectorAll('[data-editor-pane]');

function formatMineWikiDateTime(value = new Date()) {
  const pad = (part) => String(part).padStart(2, '0');
  return `${value.getFullYear()}.${pad(value.getMonth() + 1)}.${pad(value.getDate())}. ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

const templates = {
  document_status: `{{문서 상태\n|기준=Java Edition 1.21\n|상태=검증 필요\n|확인일=${formatMineWikiDateTime()}\n}}\n`,
  mob_info: `{{몹 정보\n|이름=\n|영문=\n|이미지=\n|분류=\n|체력=\n|공격력=\n|스폰=\n|드롭=\n|경험치=\n|에디션=\n}}\n`,
  block_info: `{{블록 정보\n|이름=\n|영문=\n|이미지=\n|종류=\n|투명=\n|밝기=\n|경도=\n|폭발 저항=\n|도구=\n|중첩=\n|획득=\n}}\n`,
  item_info: `{{아이템 정보\n|이름=\n|영문=\n|이미지=\n|종류=\n|중첩=\n|내구도=\n|희귀도=\n|획득=\n|사용처=\n}}\n`,
  mod_info: `{{모드 정보\n|이름=\n|영문=\n|분류=\n|로더=\n|지원 버전=\n|클라이언트 필요=\n|서버 필요=\n|의존성=\n|공식 링크=\n|라이선스=\n|마지막 확인=${formatMineWikiDateTime()}\n}}\n`,
  server_info: `{{서버 정보\n|이름=\n|주소=\n|에디션=Java Edition\n|지원 버전=\n|장르=\n|인증=미인증\n|운영 상태=인증 없음\n|화이트리스트=\n|상태 확인=미사용\n}}\n`,
  crafting_recipe: `{{조합법\n|1=\n|2=\n|3=\n|4=\n|5=\n|6=\n|7=\n|8=\n|9=\n|결과=\n|수량=1\n}}\n`,
  command_info: `{{명령어 정보\n|명령어=\n|권한=\n|에디션=\n|문법=\n|설명=\n}}\n`,
  drop_table: `{{드롭 표\n|아이템=\n|종류=\n|비고=\n}}\n`,
  smelting_recipe: `{{제련법\n|입력=\n|연료=\n|결과=\n|경험치=\n|시간=\n}}\n`,
  villager_trade: `{{주민 거래\n|직업=\n|레벨=\n|구매=\n|판매=\n|비고=\n}}\n`,
  edition_diff: `{{에디션 차이\n|Java=\n|Bedrock=\n|비고=\n}}\n`,
  version_history: `{{버전 역사\n|1.21=\n|1.20=\n|1.19=\n|비고=\n}}\n`,
  mod_version_table: `{{모드 버전표\n|모드 버전=\n|Minecraft=\n|로더=\n|변경점=\n|비고=\n}}\n`,
  develop_status: `{{개발 문서 상태\n|대상=Java Edition\n|버전=1.21.x\n|검증=필요\n|출처=공식 문서, 테스트\n|확인일=${formatMineWikiDateTime()}\n}}\n`,
  api_info: `{{API 정보\n|이름=\n|대상=Plugin\n|언어=Java\n|지원=Paper\n|버전=1.21.x\n|공식 링크=\n|설명=\n}}\n`,
  packet_info: `{{패킷 정보\n|이름=\n|방향=\n|상태=play\n|버전=1.21.x\n|ID=\n|필드=\n|설명=\n}}\n`,
  data_type_info: `{{데이터 타입\n|이름=\n|종류=\n|크기=\n|범위=\n|설명=\n}}\n`,
  version_support: `{{버전 지원표\n|열=버전,지원,상태,비고\n|행1=1.21.x,지원,확인 필요,\n|행2=\n|행3=\n}}\n`,
  code_example: `{{코드 예제\n|제목=예제\n|언어=java\n|코드=\n}}\n`,
  warning_box: `{{경고 박스\n|제목=주의\n|내용=\n}}\n`,
  official_doc_link: `{{공식 문서 링크\n|제목=\n|URL=https://\n|확인일=${formatMineWikiDateTime()}\n}}\n`,
  dependency_info: `{{의존성 정보\n|열=이름,범위,버전,비고\n|행1=\n|행2=\n|행3=\n}}\n`,
  gradle_setup: `{{Gradle 설정\n|내용=\n}}\n`,
  maven_setup: `{{Maven 설정\n|내용=\n}}\n`,
  nbt_structure: `{{NBT 구조\n|열=태그,타입,설명\n|행1=\n|행2=\n|행3=\n}}\n`,
  protocol_fields: `{{프로토콜 필드 표\n|열=필드,타입,설명\n|행1=\n|행2=\n|행3=\n}}\n`
};

const formSchemas = {
  mob_info: {
    label: '몹 정보',
    fields: ['이름', '영문', '이미지', '분류', '체력', '공격력', '스폰', '드롭', '경험치', '에디션']
  },
  block_info: {
    label: '블록 정보',
    fields: ['이름', '영문', '이미지', '종류', '투명', '밝기', '경도', '폭발 저항', '도구', '중첩', '획득']
  },
  item_info: {
    label: '아이템 정보',
    fields: ['이름', '영문', '이미지', '종류', '중첩', '내구도', '희귀도', '획득', '사용처']
  },
  mod_info: {
    label: '모드 정보',
    fields: ['이름', '영문', '분류', '로더', '지원 버전', '클라이언트 필요', '서버 필요', '의존성', '공식 링크', '소스 코드', '라이선스', '한국어', '마지막 확인']
  },
  server_info: {
    label: '서버 정보',
    fields: ['이름', '주소', '에디션', '지원 버전', '장르', '인증', '운영 상태', '화이트리스트', '디스코드', '공식 사이트', '상태 확인', '마지막 확인']
  },
  crafting_recipe: {
    label: '조합법',
    fields: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '결과', '수량']
  },
  command_info: {
    label: '명령어 정보',
    fields: ['명령어', '권한', '에디션', '문법', '설명']
  },
  drop_table: {
    label: '드롭 표',
    fields: ['아이템', '종류', '비고']
  },
  smelting_recipe: {
    label: '제련법',
    fields: ['입력', '연료', '결과', '경험치', '시간']
  },
  villager_trade: {
    label: '주민 거래',
    fields: ['직업', '레벨', '구매', '판매', '비고']
  },
  edition_diff: {
    label: '에디션 차이',
    fields: ['Java', 'Bedrock', '비고']
  },
  version_history: {
    label: '버전 역사',
    fields: ['1.21', '1.20', '1.19', '비고']
  },
  mod_version_table: {
    label: '모드 버전표',
    fields: ['모드 버전', 'Minecraft', '로더', '변경점', '비고']
  },
  develop_status: {
    label: '개발 문서 상태',
    fields: ['대상', '버전', '검증', '출처', '확인일']
  },
  api_info: {
    label: 'API 정보',
    fields: ['이름', '대상', '언어', '지원', '버전', '공식 링크', '설명']
  },
  packet_info: {
    label: '패킷 정보',
    fields: ['이름', '방향', '상태', '버전', 'ID', '필드', '설명']
  },
  data_type_info: {
    label: '데이터 타입',
    fields: ['이름', '종류', '크기', '범위', '설명']
  },
  version_support: {
    label: '버전 지원표',
    fields: ['열', '행1', '행2', '행3']
  },
  code_example: {
    label: '코드 예제',
    fields: ['제목', '언어', '코드']
  },
  warning_box: {
    label: '경고 박스',
    fields: ['제목', '내용']
  },
  official_doc_link: {
    label: '공식 문서 링크',
    fields: ['제목', 'URL', '확인일']
  },
  dependency_info: {
    label: '의존성 정보',
    fields: ['열', '행1', '행2', '행3']
  },
  gradle_setup: {
    label: 'Gradle 설정',
    fields: ['내용']
  },
  maven_setup: {
    label: 'Maven 설정',
    fields: ['내용']
  },
  nbt_structure: {
    label: 'NBT 구조',
    fields: ['열', '행1', '행2', '행3']
  },
  protocol_fields: {
    label: '프로토콜 필드 표',
    fields: ['열', '행1', '행2', '행3']
  }
};

let syncingForm = false;

async function renderPreview() {
  if (!textarea || !preview) return;
  const pageId = document.querySelector('input[name="pageId"]')?.value || location.pathname.match(/\/api\/pages\/(\d+)/)?.[1] || '';
  const endpoint = pageId ? `/api/pages/${encodeURIComponent(pageId)}/preview` : '/api/preview';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: textarea.value })
  });
  const data = res.ok ? await res.json() : { html: '<aside class="doc-status warning"><strong>미리보기 실패</strong><span>잠시 뒤 다시 시도하세요.</span></aside>' };
  setPreviewHtml(data.html);
}

function activateTab(name) {
  tabButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.editorTab === name);
    button.setAttribute('aria-selected', button.dataset.editorTab === name ? 'true' : 'false');
  });
  tabPanes.forEach((pane) => pane.classList.toggle('active', pane.dataset.editorPane === name));
  if (name === 'preview') renderPreview();
  if (name === 'tools') renderForm();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function componentPattern(schema) {
  return new RegExp(`\\{\\{${escapeRegExp(schema.label)}\\s*\\n([\\s\\S]*?)\\n?\\}\\}`, 'm');
}

function readComponent(schema) {
  if (!textarea) return {};
  const match = textarea.value.match(componentPattern(schema));
  if (!match) return {};
  const props = {};
  for (const line of match[1].split('\n')) {
    const prop = line.match(/^\|([^=]+)=(.*)$/);
    if (prop) props[prop[1].trim()] = prop[2].trim();
  }
  return props;
}

function componentBlock(schema, props) {
  return [`{{${schema.label}`, ...schema.fields.map((field) => `|${field}=${props[field] ?? ''}`), '}}'].join('\n');
}

function writeComponent(schema, props) {
  if (!textarea) return;
  const block = componentBlock(schema, props);
  const pattern = componentPattern(schema);
  textarea.value = pattern.test(textarea.value) ? textarea.value.replace(pattern, block) : `${block}\n\n${textarea.value}`;
}

function selectedFormSchema() {
  return formSchemas[formSelect?.value] ?? formSchemas.mod_info;
}

function renderForm() {
  if (!formEditor || !formSelect || !formFields) return;
  const schema = selectedFormSchema();
  const props = readComponent(schema);
  formFields.replaceChildren(
    ...schema.fields.map((field) => {
      const label = document.createElement('label');
      label.append(document.createTextNode(field));
      const input = document.createElement('input');
      input.dataset.componentField = field;
      input.value = props[field] ?? '';
      label.append(input);
      return label;
    })
  );
}

function syncFormToSource() {
  if (!formFields) return;
  const schema = selectedFormSchema();
  const props = {};
  formFields.querySelectorAll('[data-component-field]').forEach((input) => {
    props[input.dataset.componentField] = input.value;
  });
  syncingForm = true;
  writeComponent(schema, props);
  syncingForm = false;
  renderPreview();
}

function setupFormEditor() {
  if (!formEditor || !formSelect || !formFields || !textarea) return;
  const allowed = new Set((formSelect.dataset.componentForms || '').split(',').map((key) => key.trim()).filter(Boolean));
  const entries = Object.entries(formSchemas).filter(([key]) => !allowed.size || allowed.has(key));
  if (!entries.length) {
    formEditor.hidden = true;
    return;
  }
  formSelect.replaceChildren(
    ...entries.map(([key, schema]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = schema.label;
      return option;
    })
  );
  const existingKey = entries.find(([, schema]) => componentPattern(schema).test(textarea.value))?.[0];
  if (existingKey) formSelect.value = existingKey;
  formSelect.addEventListener('change', renderForm);
  formFields.addEventListener('input', syncFormToSource);
  textarea.addEventListener('input', () => {
    if (!syncingForm) renderForm();
  });
  renderForm();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function setPreviewHtml(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  sanitizePreviewNode(doc.body);
  preview.replaceChildren(...Array.from(doc.body.childNodes));
}

function sanitizePreviewNode(root) {
  const blockedElements = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META']);
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (blockedElements.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on') || name === 'srcdoc' || /[\u0000-\u001f\u007f]/.test(value)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (['href', 'src', 'action', 'formaction', 'poster'].includes(name) && !isSafePreviewUrl(value)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style' && /(?:url\s*\(|expression\s*\(|@import|javascript:)/i.test(value)) {
        element.removeAttribute(attr.name);
      }
    }
  }
}

function isSafePreviewUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  if (text.startsWith('#')) return true;
  if (text.startsWith('/') && !text.startsWith('//')) return true;
  try {
    const url = new URL(text, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

let timer;
textarea?.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(renderPreview, 250);
});

document.querySelectorAll('[data-template]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!textarea) return;
    const text = templates[button.dataset.template] || '';
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    activateTab('source');
    renderPreview();
  });
});

tabButtons.forEach((button) => {
  button.addEventListener('click', () => activateTab(button.dataset.editorTab));
});

setupFormEditor();
renderPreview();
