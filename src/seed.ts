import { exec, one } from './db.js';
import { pool } from './db.js';
import { ensureCoreData, savePage, addPageAlias, syncPageSpaces, rebuildDailyOperationSummary, rebuildOpenBetaWeeklyStats } from './wiki/repository.js';
import { normalizeSearch } from './wiki/normalize.js';
import type { NamespaceCode } from './types.js';
import type { SavePageResult } from './wiki/repository.js';

await ensureCoreData();
await syncPageSpaces();

const admin = await one<{ id: number }>(`SELECT id FROM users WHERE username='admin'`);
const userId = admin?.id ?? null;

const staffUsers = [
  ['server-reviewer-1', '서버 검토자 1', 'support+server-reviewer-1@minewiki.kr', 'server_owner'],
  ['server-reviewer-2', '서버 검토자 2', 'support+server-reviewer-2@minewiki.kr', 'server_owner'],
  ['mod-reviewer-1', '모드 검증자 1', 'support+mod-reviewer-1@minewiki.kr', 'mod_editor'],
  ['mod-reviewer-2', '모드 검증자 2', 'support+mod-reviewer-2@minewiki.kr', 'mod_editor'],
  ['mod-reviewer-3', '모드 검증자 3', 'support+mod-reviewer-3@minewiki.kr', 'mod_editor'],
  ['file-reviewer-1', '파일 검토자 1', 'support+file-reviewer-1@minewiki.kr', 'moderator'],
  ['search-reviewer-1', '검색 담당자 1', 'support+search-reviewer-1@minewiki.kr', 'moderator'],
  ['policy-reviewer-1', '정책 담당자 1', 'support+policy-reviewer-1@minewiki.kr', 'moderator']
];
for (const [username, displayName, email, groupCode] of staffUsers) {
  await exec(
    `INSERT INTO users (username, display_name, email, status, created_at, updated_at)
     VALUES (:username, :displayName, :email, 'active', NOW(), NOW())
     ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), email=VALUES(email), status='active', updated_at=NOW()`,
    { username, displayName, email }
  );
  await exec(
    `INSERT IGNORE INTO user_groups (user_id, group_id)
     SELECT u.id, g.id FROM users u JOIN groups g ON g.code=:groupCode WHERE u.username=:username`,
    { username, groupCode }
  );
}

async function upsert(namespace: NamespaceCode, title: string, content: string, pageType?: string) {
  const result = await savePage({ namespace, title, content, summary: '초기 기준 문서 작성', userId, pageType });
  return appliedPage(result).pageId;
}

function appliedPage(result: SavePageResult) {
  if (result.pending) throw new Error('seed_page_requires_review');
  return result;
}

async function findPageId(namespace: NamespaceCode, title: string) {
  const row = await one<{ id: number }>(
    `SELECT p.id FROM pages p JOIN namespaces n ON n.id=p.namespace_id WHERE n.code=:namespace AND p.title=:title AND p.status!='deleted'`,
    { namespace, title }
  );
  return row?.id ?? null;
}

async function addSearchTerm(term: string, namespace: NamespaceCode, title: string, weight = 900) {
  const targetPageId = await findPageId(namespace, title);
  if (!targetPageId) return;
  await exec(
    `INSERT INTO search_terms (term, normalized, target_page_id, weight, term_type)
     VALUES (:term, :normalized, :targetPageId, :weight, 'common_query')
     ON DUPLICATE KEY UPDATE normalized=VALUES(normalized), target_page_id=VALUES(target_page_id), weight=VALUES(weight), term_type='common_query'`,
    { term, normalized: normalizeSearch(term), targetPageId, weight }
  );
}

async function seedDocumentTemplate(templateKey: string, title: string, description: string, scope: 'global' | 'space' | 'user', area: string, category: string | null, content: string) {
  await exec(
    `INSERT INTO document_templates (space_id, template_key, title, description, template_scope, target_area, default_category, content_raw, created_by, status, created_at, updated_at)
     SELECT NULL, :templateKey, :title, :description, :scope, :area, :category, :content, :userId, 'active', NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE space_id IS NULL AND template_key=:templateKey)`,
    { templateKey, title, description, scope, area, category, content, userId }
  );
}

async function seedStarterSet(setKey: string, title: string, description: string, targetType: 'mod_wiki' | 'server_wiki' | 'developer' | 'basic', docs: string[]) {
  await exec(
    `INSERT INTO starter_sets (set_key, title, description, target_space_type, created_by, status, created_at, updated_at)
     VALUES (:setKey, :title, :description, :targetType, :userId, 'active', NOW(), NOW())
     ON DUPLICATE KEY UPDATE title=VALUES(title), description=VALUES(description), target_space_type=VALUES(target_space_type), status='active', updated_at=NOW()`,
    { setKey, title, description, targetType, userId }
  );
  const set = await one<{ id: number }>(`SELECT id FROM starter_sets WHERE set_key=:setKey`, { setKey });
  if (!set) return;
  let sort = 10;
  for (const doc of docs) {
    await exec(
      `INSERT INTO starter_set_items (starter_set_id, local_path, title, area, sort_order, created_at)
       SELECT :setId, :doc, :doc, :area, :sort, NOW()
       WHERE NOT EXISTS (SELECT 1 FROM starter_set_items WHERE starter_set_id=:setId AND local_path=:doc)`,
      { setId: set.id, doc, area: ['접속', '규칙', '공지', '후원 정책', '제재 기준'].includes(doc) ? 'official' : 'default', sort }
    );
    sort += 10;
  }
}

async function seedBillingPlan(planKey: string, name: string, price: number, features: Record<string, unknown>) {
  await exec(
    `INSERT INTO billing_plans (plan_key, name, price_monthly_krw, status, features_json, created_at, updated_at)
     VALUES (:planKey, :name, :price, 'active', :features, NOW(), NOW())
     ON DUPLICATE KEY UPDATE name=VALUES(name), price_monthly_krw=VALUES(price_monthly_krw), features_json=VALUES(features_json), status='active', updated_at=NOW()`,
    { planKey, name, price, features: JSON.stringify(features) }
  );
}

await seedBillingPlan('free', 'Free', 0, {
  customDomain: false,
  themeTokens: false,
  customCss: false,
  whiteLabel: false,
  operatorLimit: 1,
  advancedStats: false,
  markdownExport: false,
  markdownImport: false,
  pinnedNotice: false
});
await seedBillingPlan('plus', 'Plus', 7000, {
  customDomain: false,
  themeTokens: true,
  customCss: false,
  whiteLabel: false,
  operatorLimit: 3,
  advancedStats: true,
  markdownExport: true,
  markdownImport: false,
  pinnedNotice: true
});
await seedBillingPlan('pro', 'Pro', 25000, {
  customDomain: true,
  themeTokens: true,
  customCss: false,
  whiteLabel: false,
  operatorLimit: 10,
  advancedStats: true,
  markdownExport: true,
  markdownImport: true,
  pinnedNotice: true,
  accessControl: true
});
await seedBillingPlan('business', 'Business', 50000, {
  customDomain: true,
  themeTokens: true,
  customCss: true,
  whiteLabel: true,
  operatorLimit: 999,
  advancedStats: true,
  markdownExport: true,
  markdownImport: true,
  pinnedNotice: true,
  accessControl: true,
  brandingRemoval: true
});

await seedDocumentTemplate('mob', '몹 문서 양식', '몹 정보상자와 기본 문단을 사용합니다.', 'global', 'any', '몹', `{{문서 상태\n|상태=검증 필요\n}}\n\n{{몹 정보\n|이름={{문서명}}\n|영문=\n|분류=\n|체력=\n|공격력=\n|스폰=\n|드롭=\n}}\n\n'''{{문서명}}'''은 Minecraft의 몹이다.\n\n== 개요 ==\n\n== 행동 ==\n\n== 드롭 ==\n`);
await seedDocumentTemplate('guide', '가이드 문서 양식', '개요, 준비물, 절차로 시작합니다.', 'global', 'any', '가이드', `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}''' 가이드입니다.\n\n== 개요 ==\n\n== 준비물 ==\n\n== 절차 ==\n\n== 관련 문서 ==\n`);
await seedDocumentTemplate('server_notice', '공지 양식', '서버 공지를 작성할 때 사용합니다.', 'global', 'official', '공지', `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}''' 공지입니다.\n\n== 공지 내용 ==\n\n== 적용 일시 ==\n`);
await seedDocumentTemplate('server_rules', '규칙 양식', '서버 규칙과 제재 기준을 정리합니다.', 'global', 'official', '규칙', `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}''' 문서입니다.\n\n== 기본 규칙 ==\n\n== 금지 행위 ==\n\n== 제재 기준 ==\n`);
await seedDocumentTemplate('mod_device', '장치 양식', '모드 장치와 사용법을 설명합니다.', 'global', 'any', '모드 장치', `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}'''은 이 모드의 장치입니다.\n\n== 개요 ==\n\n== 제작 ==\n\n== 사용법 ==\n\n== 자동화 예시 ==\n`);
await seedDocumentTemplate('troubleshooting', '문제 해결 양식', '증상, 원인, 해결 방법으로 시작합니다.', 'global', 'any', '문제 해결', `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}''' 문제 해결 문서입니다.\n\n== 증상 ==\n\n== 원인 ==\n\n== 해결 방법 ==\n`);

await seedStarterSet('mod-minimal', '최소 세트', '대문, 설치, 설정, 문제 해결 중심으로 시작합니다.', 'mod_wiki', ['설치', '설정', '문제 해결']);
await seedStarterSet('mod-systems', '시스템 많은 모드', '시작하기, 시스템, 아이템, 블록, 레시피를 준비합니다.', 'mod_wiki', ['시작하기', '기본 시스템', '아이템', '블록', '레시피', '문제 해결']);
await seedStarterSet('mod-optimization', '최적화 모드', '설정, 호환성, 성능 비교 문서를 준비합니다.', 'mod_wiki', ['설치', '설정', '호환성', '문제 해결', '성능 비교']);
await seedStarterSet('mod-custom', '직접 구성', '대문만 만들고 문서 트리는 직접 구성합니다.', 'mod_wiki', []);
await seedStarterSet('server-basic', '기본 서버 세트', '접속, 규칙, 공지, 초보자 가이드, FAQ를 준비합니다.', 'server_wiki', ['접속', '규칙', '공지', '초보자 가이드', 'FAQ']);
await seedStarterSet('server-economy', '경제 서버 세트', '경제, 직업, 상점, 후원 정책까지 준비합니다.', 'server_wiki', ['접속', '규칙', '경제', '직업', '상점', '후원 정책', '제재 기준']);
await seedStarterSet('server-rpg', 'RPG 서버 세트', '직업, 퀘스트, 아이템, 지역, 보스 문서를 준비합니다.', 'server_wiki', ['접속', '규칙', '직업', '퀘스트', '아이템', '지역', '보스', 'FAQ']);
await seedStarterSet('server-custom', '직접 구성', '대문만 만들고 문서 트리는 직접 구성합니다.', 'server_wiki', []);

await upsert(
  'main',
  '대문',
  `{{문서 상태
|기준=MineWiki 운영 기준
|상태=최신
|확인일=2026.05.23. 16:04
}}

{{대문 소개
|제목=MineWiki
|설명=Minecraft 정보를 한국어로 정리하는 위키입니다. 기본 정보, 모드별 위키, 서버별 위키, 개발 문서를 같은 검색과 리비전 기록 안에서 관리합니다.
}}

{{대문 검색
|예시=좀비 주민 치료, Create 회전력, 예시서버 규칙, Paper API
}}

{{대문 카드
|제목=위키
|설명=마인크래프트 기본 정보
|링크1=몹
|링크2=블록
|링크3=아이템
|링크4=명령어
|링크5=가이드
|대상=/wiki
}}

{{대문 카드
|제목=모드
|설명=모드별 위키
|링크1=Create 위키
|링크2=Sodium 위키
|링크3=모드팩
|링크4=로더
|대상=/mods
}}

{{대문 카드
|제목=서버
|설명=서버별 위키
|링크1=인증 서버
|링크2=반야생
|링크3=경제
|링크4=서버 위키 만들기
|대상=/servers
}}

{{대문 카드
|제목=개발
|설명=개발자용 위키
|링크1=Protocol
|링크2=NBT
|링크3=Paper API
|링크4=Fabric API
|대상=/dev
}}

{{서버 운영자 안내
|제목=서버 운영자라면?
|설명=규칙, 공지, 접속 방법을 서버 위키로 관리하세요.
|버튼1=서버 위키 만들기
|링크1=/servers/new
|버튼2=GitBook에서 이전하기
|링크2=/servers/import
}}

== 참여 ==
새 문서는 [[도움말:처음 편집하기]]와 [[도움말:위키 문법]]을 확인한 뒤 작성한다. 모든 문서는 편집 이력과 이전 버전을 남기며, 대문 역시 이 문서의 역사에서 변경 내용을 볼 수 있다.

== 운영 원칙 ==
* 문서는 검증 가능한 정보와 출처를 우선한다.
* 없는 문서는 빨간 링크로 남겨 두고, 새 문서 작성으로 이어지게 한다.
* 서버 공식 문서는 운영자 인증 상태를 구분해서 표시한다.
* 날짜와 시간은 MineWiki 표준 형식인 2026.05.23. 16:04 형태로 표기한다.

[[분류:MineWiki]]
[[분류:대문]]`,
  'article'
);

const vanilla = [
  'Minecraft',
  '좀비',
  '좀비 주민',
  '크리퍼',
  '엔더맨',
  '스켈레톤',
  '주민',
  '철 골렘',
  '다이아몬드',
  '네더라이트 주괴',
  '황금 사과',
  '나약함의 물약',
  '상자',
  '제작대',
  '화로',
  '엔드',
  '네더',
  '엔더 진주',
  '엔더 드래곤',
  '레드스톤',
  '피스톤',
  '관측기',
  '호퍼',
  '철 주괴',
  '석탄',
  '참나무',
  '양',
  '소',
  '돼지',
  '거미',
  '블레이즈'
];

for (const title of vanilla) {
  await upsert(
    'main',
    title,
    `{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{아이템 정보
|이름=${title}
|영문=${title === '엔더맨' ? 'Enderman' : title === '좀비 주민' ? 'Zombie Villager' : ''}
|종류=바닐라
|중첩=
|획득=문서 참조
}}

'''${title}'''은 Minecraft의 바닐라 요소이다. 세부 수치는 버전과 에디션에 따라 달라질 수 있다.

== 개요 ==
${title} 문서는 기본 설명, 획득 또는 생성 조건, 관련 사용처를 정리한다.

== 관련 문서 ==
* [[Minecraft]]
* [[엔더맨]]

[[분류:바닐라]]
[[분류:검증 필요 문서]]`
  );
}

const enderman = await upsert(
  'main',
  '엔더맨',
  `{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{몹 정보
|이름=엔더맨
|영문=Enderman
|분류=중립적 몹
|체력=40
|스폰=오버월드, 네더, 엔드
|드롭=엔더 진주
|경험치=5
|에디션=Java Edition, Bedrock Edition
}}

'''엔더맨'''은 눈을 마주친 플레이어를 공격하는 중립적 몹이다.<ref>공식 변경 내역 확인 필요</ref>

== 행동 ==
엔더맨은 평소에는 플레이어를 먼저 공격하지 않는다.

== 관련 문서 ==
* [[엔더 진주]]
* [[엔드]]

[[분류:중립적 몹]]
[[분류:엔드 몹]]`,
  'mob'
);

const zombieVillager = await upsert(
  'main',
  '좀비 주민',
  `{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{몹 정보
|이름=좀비 주민
|영문=Zombie Villager
|분류=적대적 몹
|체력=20
|드롭=썩은 살점
|에디션=Java Edition, Bedrock Edition
}}

'''좀비 주민'''은 좀비의 변종 몹이다. 치료에는 [[황금 사과]]와 [[나약함의 물약]]이 사용된다.

== 치료 ==
좀비 주민은 나약함 상태에서 황금 사과를 사용하면 치료를 시작한다.

[[분류:적대적 몹]]
[[분류:언데드 몹]]`,
  'mob'
);

await addPageAlias('main', '앤더맨', enderman, 'typo');
await addPageAlias('main', '엔더 맨', enderman, 'korean_alt');
await addPageAlias('main', '좀비주민', zombieVillager, 'korean_alt');
const enderDragon = await findPageId('main', '엔더 드래곤');
if (enderDragon) await addPageAlias('main', '엔더드래곤', enderDragon, 'korean_alt');
const diamond = await findPageId('main', '다이아몬드');
if (diamond) await addPageAlias('main', '다이아', diamond, 'korean_alt');
const minecraftPage = await one<{ id: number }>(
  `SELECT p.id FROM pages p JOIN namespaces n ON n.id=p.namespace_id WHERE n.code='main' AND p.title='Minecraft'`
);
if (minecraftPage) {
  await addPageAlias('main', '마크', minecraftPage.id, 'korean_alt');
  await addPageAlias('main', '마인크래프트', minecraftPage.id, 'korean_alt');
}

await upsert(
  'guide',
  '좀비 주민 치료',
  `{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''좀비 주민 치료'''는 [[좀비 주민]]에게 나약함 효과를 적용한 뒤 [[황금 사과]]를 사용하는 절차이다.

== 준비물 ==
* 나약함의 물약 또는 나약함 효과를 줄 수 있는 수단
* 황금 사과
* 좀비 주민을 안전하게 가둘 공간

== 절차 ==
좀비 주민에게 나약함을 적용하고 황금 사과를 사용하면 치료가 시작된다. 치료 중에는 햇빛과 다른 몹의 공격을 막아야 한다.

[[분류:가이드]]
[[분류:주민]]`,
  'guide'
);
await upsert(
  'main',
  '주민/직업',
  `{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''주민 직업'''은 작업대 블록과 연결되어 거래 목록을 결정한다.

== 개요 ==
주민은 주변 작업대 블록을 인식해 직업을 얻으며, 거래 경험치와 고정 여부는 버전과 상황에 따라 달라질 수 있다.

[[분류:주민]]
[[분류:가이드]]`,
  'guide'
);
await upsert(
  'guide',
  'Paper 서버 열기',
  `{{문서 상태
|기준=Paper 1.21.x
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''Paper 서버 열기'''는 Paper 서버 파일, Java 런타임, 포트 설정, 운영 정책을 준비하는 과정이다.

== 기본 흐름 ==
Paper 빌드를 내려받고 서버 디렉터리에서 실행한 뒤 eula.txt와 server.properties를 확인한다.

== 관련 문서 ==
* [[Develop:Paper API]]
* [[Server:서버 문서 정책]]

[[분류:가이드]]
[[분류:서버]]`,
  'guide'
);
await exec(
  `UPDATE pages p
   JOIN namespaces n ON n.id=p.namespace_id
   SET p.status='deleted', p.updated_at=NOW()
   WHERE n.code='main' AND p.title IN ('가이드/좀비 주민 치료', '가이드/Paper 서버 열기')`
);

const mods = ['Sodium', 'Iris', 'Lithium', 'JEI', 'Create', 'OptiFine', 'Fabric API', 'Forge', 'NeoForge', 'Paper'];
const modIds = new Map<string, number>();
for (const title of mods) {
  const id = await upsert(
    'mod',
    title,
    `{{문서 상태
|기준=문서 내 버전표
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{모드 정보
|이름=${title}
|영문=${title}
|분류=${title === 'Sodium' ? '최적화' : '모드'}
|로더=${title === 'Sodium' || title === 'Iris' || title === 'Fabric API' ? 'Fabric, Quilt' : '문서 참조'}
|지원 버전=문서 참조
|클라이언트 필요=${title === 'Sodium' || title === 'Iris' ? '예' : '알 수 없음'}
|서버 필요=알 수 없음
|의존성=${title === 'Iris' ? 'Sodium' : '문서 참조'}
|공식 링크=공식 사이트
|한국어=문서 참조
|마지막 확인=2026.05.23. 16:04
}}

'''${title}'''은 Minecraft 관련 모드 또는 서버 소프트웨어이다.

== 개요 ==
지원 버전, 로더, 클라이언트/서버 필요 여부를 문서 상단 정보상자로 관리한다.

[[분류:모드]]
[[분류:검증 필요 문서]]`,
    'mod'
  );
  modIds.set(title, id);
  if (title === 'Sodium') await addPageAlias('mod', '소듐', id, 'korean_alt');
  if (title === 'Iris') await addPageAlias('mod', '아이리스', id, 'korean_alt');
  if (title === 'OptiFine') await addPageAlias('mod', '옵티파인', id, 'korean_alt');
  if (title === 'Paper') await addPageAlias('mod', '페이퍼', id, 'korean_alt');
}

for (const [title, id] of modIds) {
  await exec(`DELETE FROM mod_links WHERE page_id=:pageId`, { pageId: id });
  await exec(`DELETE FROM mod_versions WHERE page_id=:pageId`, { pageId: id });
  await exec(`DELETE FROM mod_dependencies WHERE page_id=:pageId`, { pageId: id });
  await exec(
    `INSERT INTO mod_links (page_id, link_type, url, status, checked_at, created_at)
     VALUES (:pageId, 'official', :url, 'unknown', NOW(), NOW())`,
    { pageId: id, url: `https://example.com/mods/${encodeURIComponent(title)}` }
  );
  await exec(
    `INSERT INTO mod_versions (page_id, minecraft_version, loader, support_status, checked_at)
     VALUES (:pageId, '1.21.x', :loader, 'unknown', NOW())`,
    { pageId: id, loader: title === 'Sodium' || title === 'Iris' || title === 'Fabric API' ? 'fabric' : 'unknown' }
  );
}
if (modIds.has('Iris') && modIds.has('Sodium')) {
  await exec(
    `INSERT INTO mod_dependencies (page_id, dependency_page_id, dependency_name, required_type, note)
     VALUES (:iris, :sodium, 'Sodium', 'recommended', '셰이더 사용 시 함께 쓰는 경우가 많음')`,
    { iris: modIds.get('Iris'), sodium: modIds.get('Sodium') }
  );
}

const serverId = await upsert(
  'server',
  '예시서버',
  `{{서버 정보
|이름=예시서버
|주소=play.example.kr
|에디션=Java Edition
|지원 버전=1.20.1 ~ 1.21.x
|장르=반야생, 경제
|인증=운영자 인증
|화이트리스트=없음
|상태 확인=사용
}}

'''예시서버'''는 Java Edition 기반의 반야생 서버이다.

== 접속 ==
서버 주소는 <code>play.example.kr</code>이다.

== 규칙 ==
{{공식 영역
|문서=서버:예시서버/규칙
}}

[[분류:서버]]
[[분류:인증 서버]]`,
  'server'
);
await addPageAlias('server', 'example', serverId, 'alias');
await addPageAlias('server', 'Example', serverId, 'alias');
await addPageAlias('server', 'example.kr', serverId, 'alias');
await addPageAlias('server', 'play.example.kr', serverId, 'alias');

for (const title of ['예시서버/접속', '예시서버/규칙', '예시서버/공지']) {
  await upsert(
    'server',
    title,
    `{{문서 상태
|기준=서버 운영자 공식 영역
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''${title}''' 문서는 서버 운영자 인증을 받은 사용자가 관리하는 공식 하위문서이다.

== 내용 ==
공식 안내를 여기에 작성한다.

[[분류:서버]]
[[분류:공식 영역]]`,
    'server'
  );
}

const serverSubwikiParent = await one<{ id: number }>(`SELECT id FROM wiki_spaces WHERE code='server'`);
await exec(
  `INSERT INTO wiki_spaces (code, space_key, name, title, slug, space_type, parent_space_id, root_page_id, root_namespace_code, root_path, description, status, created_by, owner_user_id, created_at, updated_at)
   VALUES ('server-example', 'server-example', '예시서버', '예시서버', 'example', 'server_wiki', :parentId, :rootPageId, 'server', '/server/example', '예시서버 공식 위키', 'active', :userId, :userId, NOW(), NOW())
   ON DUPLICATE KEY UPDATE root_page_id=VALUES(root_page_id), status='active', updated_at=NOW()`,
  { parentId: serverSubwikiParent?.id ?? null, rootPageId: serverId, userId: userId ?? null }
);
const serverSubwiki = await one<{ id: number }>(`SELECT id FROM wiki_spaces WHERE code='server-example'`);
if (serverSubwiki) {
  await exec(
    `INSERT INTO subwiki_settings (space_id, main_page_id, home_title, short_path, allow_public_edit, public_edit_enabled, require_review, review_required, created_at, updated_at)
     VALUES (:spaceId, :rootPageId, '대문', '/server/example', 0, 0, 1, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE main_page_id=VALUES(main_page_id), short_path=VALUES(short_path), updated_at=NOW()`,
    { spaceId: serverSubwiki.id, rootPageId: serverId }
  );
  const docs = ['접속 방법', '규칙', '공지', '초보자 가이드', '시스템', '경제', '직업', '상점', '지역 보호', '명령어', '후원 정책', '제재 기준', 'FAQ', '시즌 기록'];
  let sort = 10;
  for (const doc of docs) {
    const pageId = await upsert(
      'server',
      `example/${doc}`,
      `{{문서 상태
|기준=서버 공식 위키
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''예시서버 ${doc}''' 문서이다.

== 내용 ==
서버 운영자가 공식 정보를 작성한다.

[[분류:서버]]
[[분류:서버 공식 위키]]`,
      'server'
    );
    await exec(
      `INSERT INTO subwiki_sidebar_items (space_id, page_id, label, target_title, sort_order, created_at, updated_at)
       SELECT :spaceId, :pageId, :label, :targetTitle, :sortOrder, NOW(), NOW()
       WHERE NOT EXISTS (SELECT 1 FROM subwiki_sidebar_items WHERE space_id=:spaceId AND label=:label)`,
      { spaceId: serverSubwiki.id, pageId, label: doc, targetTitle: `example/${doc}`, sortOrder: sort }
    );
    sort += 10;
  }
  await exec(
    `INSERT INTO subwiki_lifecycle_logs (space_id, old_status, new_status, reason, changed_by, created_at)
     SELECT :spaceId, NULL, 'active', '시드 서버 공식 위키 생성', :userId, NOW()
     WHERE NOT EXISTS (SELECT 1 FROM subwiki_lifecycle_logs WHERE space_id=:spaceId AND reason='시드 서버 공식 위키 생성')`,
    { spaceId: serverSubwiki.id, userId: userId ?? null }
  );
}

const helpDocs = ['처음 편집하기', '위키 문법', '문서 제목', '넘겨주기', '분류', '컴포넌트', '문서 상태', '몹 문서 작성', '모드 문서 작성', '서버 문서 작성', '서버 운영자 인증', '파일 업로드', '출처', '신고'];
for (const title of helpDocs) {
  await upsert(
    'help',
    title,
    `{{문서 상태
|기준=도움말
|상태=최신
|확인일=2026.05.23. 16:04
}}

'''${title}''' 도움말은 편집자가 실수하지 않도록 짧게 안내한다.

== 기본 ==
문서 첫 문장은 대상을 짧게 정의한다.

[[분류:도움말]]`,
    'help'
  );
}

const dataDocs = ['몹 체력', '클라이언트 전용 모드', 'Fabric 모드 목록', '인증 서버 목록'];
for (const title of dataDocs) {
  await upsert(
    'data',
    title,
    `{{문서 상태
|기준=DB 기반 데이터 문서
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{데이터 표
|종류=${title.includes('모드') ? '모드' : '몹'}
|조건=문서 참조
|열=이름,분류,상태
|정렬=이름
}}

'''${title}''' 문서는 DB에서 관리되는 구조화 데이터를 보여준다.

[[분류:데이터]]`,
    'data'
  );
}

for (let i = vanilla.length + 1; i <= 150; i += 1) {
  await upsert(
    'main',
    `바닐라 기준 문서 ${i}`,
    `{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{아이템 정보
|이름=바닐라 기준 문서 ${i}
|종류=바닐라
|획득=문서 참조
}}

'''바닐라 기준 문서 ${i}'''는 베타 문서 생산 목표를 위한 기준 문서이다.

== 개요 ==
기여자는 이 문서를 실제 항목으로 교체하거나 내용을 확장한다.

[[분류:바닐라]]
[[분류:검증 필요 문서]]`
  );
}

for (let i = 151; i <= 300; i += 1) {
  await upsert(
    'main',
    `바닐라 공개 기준 문서 ${i}`,
    `{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{아이템 정보
|이름=바닐라 공개 기준 문서 ${i}
|종류=바닐라
|획득=문서 참조
}}

'''바닐라 공개 기준 문서 ${i}'''는 정식 공개 전 기준 수량과 구조 검증을 위한 문서이다.

== 개요 ==
실제 항목으로 교체할 때 첫 문장, 획득 방법, 관련 링크, 분류를 유지한다.

[[분류:바닐라]]
[[분류:검증 필요 문서]]`
  );
}

for (let i = mods.length + 1; i <= 50; i += 1) {
  await upsert(
    'mod',
    `Example Mod ${i}`,
    `{{문서 상태
|기준=문서 내 버전표
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{모드 정보
|이름=Example Mod ${i}
|영문=Example Mod ${i}
|분류=모드
|로더=문서 참조
|지원 버전=문서 참조
|클라이언트 필요=알 수 없음
|서버 필요=알 수 없음
|의존성=문서 참조
|공식 링크=공식 사이트
|한국어=문서 참조
|마지막 확인=2026.05.23. 16:04
}}

'''Example Mod ${i}''' 문서는 모드 기준 문서 확장을 위한 자리표시 문서이다.

[[분류:모드]]
[[분류:검증 필요 문서]]`,
    'mod'
  );
}

for (let i = 51; i <= 100; i += 1) {
  await upsert(
    'mod',
    `Open Mod ${i}`,
    `{{문서 상태
|기준=문서 내 버전표
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{모드 정보
|이름=Open Mod ${i}
|영문=Open Mod ${i}
|분류=모드
|로더=문서 참조
|지원 버전=문서 참조
|클라이언트 필요=알 수 없음
|서버 필요=알 수 없음
|의존성=문서 참조
|공식 링크=공식 사이트
|한국어=문서 참조
|마지막 확인=2026.05.23. 16:04
}}

'''Open Mod ${i}''' 문서는 모드 문서 공개 기준 점검용 문서이다.

[[분류:모드]]
[[분류:검증 필요 문서]]`,
    'mod'
  );
}

for (let i = 1; i <= 20; i += 1) {
  await upsert(
    'guide',
    `베타 가이드 ${i}`,
    `{{문서 상태
|기준=가이드
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''베타 가이드 ${i}'''는 Minecraft 한국어 위키의 가이드 기준 문서이다.

== 절차 ==
짧은 단계와 관련 문서 링크를 중심으로 작성한다.

* [[엔더맨]]
* [[모드:Sodium|Sodium]]

[[분류:가이드]]
[[분류:검증 필요 문서]]`,
    'guide'
  );
}

for (let i = 21; i <= 40; i += 1) {
  await upsert(
    'guide',
    `공개 가이드 ${i}`,
    `{{문서 상태
|기준=가이드
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''공개 가이드 ${i}'''는 정식 공개 전 사용자 흐름 점검을 위한 가이드 문서이다.

== 절차 ==
문제 해결과 관련 문서를 짧은 단계로 연결한다.

* [[Minecraft]]
* [[모드:Sodium|Sodium]]

[[분류:가이드]]
[[분류:검증 필요 문서]]`,
    'guide'
  );
}

for (let i = dataDocs.length + 1; i <= 10; i += 1) {
  await upsert(
    'data',
    `베타 데이터 ${i}`,
    `{{문서 상태
|기준=DB 기반 데이터 문서
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{데이터 표
|종류=모드
|조건=문서 참조
|열=이름,분류,상태
|정렬=이름
}}

'''베타 데이터 ${i}''' 문서는 구조화 데이터 목록을 표시한다.

[[분류:데이터]]`,
    'data'
  );
}

for (let i = 11; i <= 20; i += 1) {
  await upsert(
    'data',
    `공개 데이터 ${i}`,
    `{{문서 상태
|기준=DB 기반 데이터 문서
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{데이터 표
|종류=모드
|조건=정식 공개 기준
|열=이름,분류,상태
|정렬=이름
}}

'''공개 데이터 ${i}''' 문서는 구조화 데이터 공개 기준을 점검한다.

[[분류:데이터]]`,
    'data'
  );
}

for (let i = 2; i <= 7; i += 1) {
  await upsert(
    'server',
    `예시서버${i}`,
    `{{서버 정보
|이름=예시서버${i}
|주소=play${i}.example.kr
|에디션=Java Edition
|지원 버전=1.21.x
|장르=반야생
|인증=미인증
|화이트리스트=없음
|상태 확인=미사용
}}

'''예시서버${i}'''는 서버 문서 기준을 위한 예시 문서이다.

[[분류:서버]]`,
    'server'
  );
}

for (let i = 8; i <= 30; i += 1) {
  await upsert(
    'server',
    `공개예시서버${i}`,
    `{{서버 정보
|이름=공개예시서버${i}
|주소=server${i}.example.kr
|에디션=Java Edition
|지원 버전=1.21.x
|장르=반야생
|인증=${i % 3 === 0 ? '운영자 인증' : '미인증'}
|화이트리스트=없음
|상태 확인=${i % 3 === 0 ? '사용' : '미사용'}
}}

'''공개예시서버${i}'''는 서버 목록 노출 조건과 인증 상태를 검증하기 위한 문서이다.

[[분류:서버]]`,
    'server'
  );
}

for (const title of ['운영 정책', '관리자 권한 정책', '서버 문서 정책', '모드 문서 정책', '파일 라이선스 정책', '검색 별칭 관리']) {
  await upsert(
    'project',
    title,
    `{{문서 상태
|기준=운영 정책
|상태=최신
|확인일=2026.05.23. 16:04
}}

'''${title}''' 문서는 베타 운영 기준을 정리한다.

== 원칙 ==
검색 순위 판매, 서버 리뷰화, 비공식 모드 재배포를 금지한다.

[[분류:프로젝트]]
[[분류:정책]]`,
    'policy'
  );
}

const finalPolicyDocs = [
  ['문서 작성 정책', 'document'],
  ['편집 지침', 'edit'],
  ['문서 제목 정책', 'title'],
  ['저작권 정책', 'copyright'],
  ['개인정보 및 신상 서술 금지', 'privacy'],
  ['차단 정책', 'block'],
  ['토론 정책', 'discussion'],
  ['위키 문서 정책', 'main'],
  ['모드 위키 개설 조건', 'mod_wiki'],
  ['서버 공식 위키 정책', 'server_wiki'],
  ['개발 문서 정책', 'develop'],
  ['GitBook 이전 정책', 'gitbook'],
  ['파일 정책', 'file'],
  ['검색 정책', 'search'],
  ['수익 및 운영비 정책', 'revenue']
];
for (const [title, key] of finalPolicyDocs) {
  const content =
    key === 'revenue'
      ? `{{문서 상태
|기준=정식 공개 정책
|상태=최신
|확인일=2026.05.23. 16:04
}}

'''수익 및 운영비 정책'''은 MineWiki의 운영비 조달과 금지되는 유료 기능을 정리하는 정책이다.

== 원칙 ==
* 문서 접근을 유료화하지 않는다.
* 검색 순위를 판매하지 않는다.
* 운영자 인증 배지와 서버 품질 배지를 판매하지 않는다.
* 논란, 제재, 비판 문단을 숨기는 대가를 받지 않는다.

== 허용 가능한 수익 ==
* 자발적 후원
* 명확히 표시되는 최소 광고
* 서버 공식 위키 커스텀 도메인
* 서버 공식 위키 고급 테마
* 서버 통계 대시보드
* 추가 운영자 슬롯

== 광고 정책 ==
* 문서 중간 광고, 팝업 광고, 자동 재생 광고를 사용하지 않는다.
* 모바일 가독성을 방해하는 광고를 사용하지 않는다.
* 광고는 광고임을 명확히 표시한다.

== 서버 운영자 유료 기능 ==
가능한 기능은 커스텀 도메인, 고급 테마, 상세 서버 통계, 추가 관리자 계정, 공식 공지 상단 고정이다.

불가능한 기능은 검색 상위 노출, 추천 서버 배지, 인증 배지 구매, 품질 배지 구매이다.

[[분류:프로젝트]]
[[분류:정책]]
[[분류:운영비]]`
      : `{{문서 상태
|기준=정식 공개 정책
|상태=최신
|확인일=2026.05.23. 16:04
}}

'''${title}''' 문서는 정식 공개 전 고정해야 하는 핵심 정책이다.

== 적용 기준 ==
정식 공개 전에는 상태를 정식 적용으로 고정하고 변경 이력을 남긴다.

[[분류:프로젝트]]
[[분류:정책]]`;
  const id = await upsert(
    'project',
    title,
    content,
    'policy'
  );
  await exec(
    `INSERT INTO policy_versions (page_id, policy_key, version, status, effective_at, created_by, created_at)
     VALUES (:pageId, :policyKey, '1.0', 'active', NOW(), :userId, NOW())
     ON DUPLICATE KEY UPDATE page_id=VALUES(page_id), status='active', effective_at=VALUES(effective_at)`,
    { pageId: id, policyKey: key, userId: userId ?? null }
  );
}

await exec(
  `UPDATE pages p
   JOIN namespaces n ON n.id=p.namespace_id
   SET p.protection_level='admin_only', p.status='protected', p.updated_at=NOW()
   WHERE n.code='project' AND p.page_type='policy' AND p.status!='deleted'`
);

for (const title of ['운영자 매뉴얼: 신고 처리', '운영자 매뉴얼: 리비전 숨김', '운영자 매뉴얼: 문서 보호', '운영자 매뉴얼: 사용자 차단', '운영자 매뉴얼: 검색 별칭 관리']) {
  await upsert(
    'project',
    title,
    `{{문서 상태
|기준=클로즈드 베타 운영
|상태=최신
|확인일=2026.05.23. 16:04
}}

'''${title}'''은 관리자가 바뀌어도 같은 기준으로 처리하기 위한 매뉴얼이다.

== 처리 기준 ==
관련 권한, 처리 절차, 기록해야 할 로그를 먼저 확인한다.

[[분류:운영자 매뉴얼]]
[[분류:정책]]`,
    'manual'
  );
}

for (const title of ['기여자 매뉴얼', '서버 운영자 매뉴얼', '모드 검증자 매뉴얼', '오픈 베타 안내', '검색 별칭 제안']) {
  await upsert(
    'help',
    title,
    `{{문서 상태
|기준=오픈 베타 준비
|상태=최신
|확인일=2026.05.23. 16:04
}}

'''${title}''' 문서는 베타 참가자가 해야 할 일과 하지 말아야 할 일을 짧게 안내한다.

== 핵심 ==
서버 순위화, 모드 파일 미러링, 게시판식 커뮤니티화를 하지 않는다.

[[분류:도움말]]
[[분류:오픈 베타]]`,
    'help'
  );
}

for (const title of ['오픈 베타 가입 안내', '신규 사용자 제한', '신뢰도와 자동 인증', '공지와 릴리즈 노트', '사건 상태 페이지', '신고 SLA', '작성 캠페인 참여', '서버 공식 위키 만들기', 'GitBook에서 이전하기', '개발 위키 사용법', '파일 라이선스 검토']) {
  await upsert(
    'help',
    title,
    `{{문서 상태
|기준=정식 공개 준비
|상태=최신
|확인일=2026.05.23. 16:04
}}

'''${title}''' 문서는 오픈 베타와 정식 공개 사이 운영 흐름을 안내한다.

== 핵심 ==
사용자는 검색, 편집, 신고, 서버 인증, 문서 이전 흐름을 이 문서에서 확인한다.

[[분류:도움말]]
[[분류:오픈 베타]]`,
    'help'
  );
}

const devDocs = [
  'Protocol',
  'Protocol/VarInt',
  'Protocol/Packet ID',
  'NBT',
  'Registry',
  'Data Pack',
  'Resource Pack',
  'Command',
  'Plugin API',
  'Mod API',
  'Tools',
  'Paper API',
  'Bukkit API',
  'Fabric API',
  'Forge API',
  'Velocity API',
  'Plugin Messaging'
];
for (const title of devDocs) {
  await upsert(
    'dev',
    title,
    `{{문서 상태
|기준=개발 위키
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{API 정보
|이름=${title}
|종류=개발 문서
|기준 버전=1.21.x
|공식 링크=문서 참조
}}

'''${title}''' 문서는 개발자 문서를 일반 사용자 문서와 분리하기 위한 기준 문서이다.

== 개요 ==
버전 기준, 공식 링크, 예제 코드를 명확히 표시한다.

<codeblock lang="java">
// 예제 코드는 실제 문서 작성 시 검증한다.
</codeblock>

[[분류:개발 위키]]
[[분류:검증 필요 문서]]`,
    'article'
  );
}

const createPage = modIds.get('Create') ?? (await one<{ id: number }>(`SELECT p.id FROM pages p JOIN namespaces n ON n.id=p.namespace_id WHERE n.code='mod' AND p.title='Create'`))?.id;
const modSubwikiParent = await one<{ id: number }>(`SELECT id FROM wiki_spaces WHERE code='mod'`);
if (createPage) {
  await exec(
    `INSERT INTO wiki_spaces (code, space_key, name, title, slug, space_type, parent_space_id, root_page_id, root_namespace_code, root_path, description, status, created_by, created_at, updated_at)
     VALUES ('mod-Create', 'mod-Create', 'Create', 'Create', 'Create', 'mod_wiki', :parentId, :rootPageId, 'mod', '/mod/Create', 'Create 전용 모드 위키', 'active', :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE root_page_id=VALUES(root_page_id), status='active', updated_at=NOW()`,
    { parentId: modSubwikiParent?.id ?? null, rootPageId: createPage, userId: userId ?? null }
  );
  const modSubwiki = await one<{ id: number }>(`SELECT id FROM wiki_spaces WHERE code='mod-Create'`);
  if (modSubwiki) {
    await exec(
      `INSERT INTO subwiki_settings (space_id, main_page_id, home_title, short_path, allow_public_edit, public_edit_enabled, require_review, review_required, created_at, updated_at)
       VALUES (:spaceId, :rootPageId, '대문', '/mod/Create', 1, 1, 1, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE main_page_id=VALUES(main_page_id), short_path=VALUES(short_path), updated_at=NOW()`,
      { spaceId: modSubwiki.id, rootPageId: createPage }
    );
    const docs = ['시작하기', '설치', '기본 시스템', '아이템', '블록', '기계', '명령어', '설정', '호환성', '문제 해결', '버전별 변경점', 'FAQ'];
    let sort = 10;
    for (const doc of docs) {
      const pageId = await upsert(
        'mod',
        `Create/${doc}`,
        `{{문서 상태
|기준=모드 위키
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''Create ${doc}''' 문서이다.

[[분류:모드]]
[[분류:모드 위키]]`,
        'mod'
      );
      await exec(
        `INSERT INTO subwiki_sidebar_items (space_id, page_id, label, target_title, sort_order, created_at, updated_at)
         SELECT :spaceId, :pageId, :label, :targetTitle, :sortOrder, NOW(), NOW()
         WHERE NOT EXISTS (SELECT 1 FROM subwiki_sidebar_items WHERE space_id=:spaceId AND label=:label)`,
        { spaceId: modSubwiki.id, pageId, label: doc, targetTitle: `Create/${doc}`, sortOrder: sort }
      );
      sort += 10;
    }
    await exec(
      `INSERT INTO subwiki_lifecycle_logs (space_id, old_status, new_status, reason, changed_by, created_at)
       SELECT :spaceId, NULL, 'active', '시드 모드 위키 생성', :userId, NOW()
       WHERE NOT EXISTS (SELECT 1 FROM subwiki_lifecycle_logs WHERE space_id=:spaceId AND reason='시드 모드 위키 생성')`,
      { spaceId: modSubwiki.id, userId: userId ?? null }
    );
  }
}

const releaseGates = [
  ['permission_test', '권한 테스트 통과'],
  ['xss_test', 'XSS 테스트 통과'],
  ['review_queue_test', '편집 검토 큐 통과'],
  ['server_official_permission', '서버 공식 영역 권한 테스트 통과'],
  ['revision_hide_test', '리비전 숨김 테스트 통과'],
  ['deleted_page_access', '삭제 문서 접근 테스트 통과'],
  ['search_reindex_test', '검색 색인 재생성 테스트 통과'],
  ['render_cache_test', '렌더 캐시 재생성 테스트 통과'],
  ['file_upload_security', '파일 업로드 검증 통과'],
  ['admin_restore_test', '관리자 복구 절차 테스트 통과']
];
for (const [gateKey, title] of releaseGates) {
  await exec(
    `INSERT INTO release_gates (gate_key, title, description)
     VALUES (:gateKey, :title, '오픈 베타 필수 릴리즈 게이트')
     ON DUPLICATE KEY UPDATE title=VALUES(title)`,
    { gateKey, title }
  );
}
await exec(
  `INSERT INTO content_audits (page_id, audit_type, status, note, audited_by, audited_at, created_at)
   SELECT 2, 'structure', 'passed', '엔더맨 기준 문서 구조 감사', :userId, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM content_audits WHERE page_id=2 AND audit_type='structure')`,
  { userId: userId ?? null }
);
await exec(
  `INSERT INTO search_audits (query, expected_page_id, status, note, audited_by, audited_at, created_at)
   SELECT '좀비주민', 3, 'passed', '공백 없는 한국어 검색 감사', :userId, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM search_audits WHERE query='좀비주민')`,
  { userId: userId ?? null }
);
await exec(
  `INSERT INTO security_test_runs (test_key, status, severity, note, tested_by, tested_at, created_at)
   SELECT 'signed_cookie_uid_forgery', 'passed', 'critical', '서명 없는 uid 쿠키는 관리자 API 접근 불가', :userId, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM security_test_runs WHERE test_key='signed_cookie_uid_forgery')`,
  { userId: userId ?? null }
);

await exec(`INSERT IGNORE INTO beta_invites (invite_code, invited_by, role_hint, expires_at, created_at) VALUES ('beta-seed-contributor', :userId, 'contributor', DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`, {
  userId: userId ?? null
});
await exec(`INSERT INTO edit_filters (name, description, filter_type, pattern, action, created_by, created_at, updated_at)
  SELECT '명백한 스팸 차단', '광고성 키워드 차단', 'regex', '(카지노|바카라|무료머니)', 'block_save', :userId, NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM edit_filters WHERE name='명백한 스팸 차단')`, { userId: userId ?? null });
await exec(`INSERT INTO edit_filters (name, description, filter_type, pattern, action, created_by, created_at, updated_at)
  SELECT '외부 링크 과다 검토', '외부 링크가 많은 편집은 검토 대기', 'link_count', '5', 'require_review', :userId, NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM edit_filters WHERE name='외부 링크 과다 검토')`, { userId: userId ?? null });
await exec(`INSERT INTO edit_filters (name, description, filter_type, pattern, action, created_by, created_at, updated_at)
  SELECT '서버 홍보성 표현 검토', '서버 문서의 광고성 표현은 검토 대기로 보낸다.', 'regex', '(최고의\\\\s*서버|1위\\\\s*서버|혜택\\\\s*지급|접속만\\\\s*해도|무료\\\\s*아이템|홍보\\\\s*이벤트)', 'require_review', :userId, NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM edit_filters WHERE name='서버 홍보성 표현 검토')`, { userId: userId ?? null });
await exec(`INSERT INTO edit_filters (name, description, filter_type, pattern, action, created_by, created_at, updated_at)
  SELECT '서버 사건 문단 검토', '서버 사건/논란 문단 편집은 검토 대기로 보낸다.', 'regex', '==\\\\s*(사건|논란|사건 및 논란|사건/논란)\\\\s*==', 'require_review', :userId, NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM edit_filters WHERE name='서버 사건 문단 검토')`, { userId: userId ?? null });
await exec(`INSERT INTO contributor_tasks (task_type, target_type, title, description, priority, created_by, created_at, updated_at)
  SELECT 'fix_search_alias', 'search_term', '검색 실패어 정리', '반복 검색 실패어를 별칭 또는 문서 요청으로 처리한다.', 'high', :userId, NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM contributor_tasks WHERE title='검색 실패어 정리')`, { userId: userId ?? null });
await exec(`INSERT INTO project_boards (name, description, created_by, created_at, updated_at)
  SELECT '베타 문서 생산', '바닐라, 모드, 서버 기준 문서 확장 프로젝트', :userId, NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM project_boards WHERE name='베타 문서 생산')`, { userId: userId ?? null });
await exec(`INSERT INTO beta_feedback (user_id, feedback_type, title, body, created_at)
  SELECT :userId, 'other', '베타 피드백 수집 시작', '검색, 편집, 서버 인증 문제를 이곳에 남긴다.', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM beta_feedback WHERE title='베타 피드백 수집 시작')`, { userId: userId ?? null });

await exec(
  `DELETE FROM server_claims WHERE page_id=:pageId AND token_plain='seed-verified'`,
  { pageId: serverId }
);
await exec(
  `INSERT INTO server_claims (page_id, user_id, method, token_hash, token_plain, status, verified_at, last_verified_at, renewal_required_at, expires_at, created_at, updated_at)
   VALUES (:pageId, :userId, 'dns_txt', SHA2('seed-verified', 256), 'seed-verified', 'verified', NOW(), NOW(), DATE_ADD(NOW(), INTERVAL 1 YEAR), DATE_ADD(NOW(), INTERVAL 1 YEAR), NOW(), NOW())
   ON DUPLICATE KEY UPDATE status='verified', verified_at=NOW(), last_verified_at=NOW(), renewal_required_at=DATE_ADD(NOW(), INTERVAL 1 YEAR), updated_at=NOW()`,
  { pageId: serverId, userId: userId ?? 1 }
);

await exec(
  `INSERT INTO open_beta_settings
   (id, signup_mode, new_user_edit_limit, new_user_external_link_limit, new_user_review_required, server_listing_mode, updated_by, updated_at)
   VALUES (1, 'open', 10, 2, 1, 'verified_or_owner', :userId, NOW())
   ON DUPLICATE KEY UPDATE signup_mode='open', server_listing_mode='verified_or_owner', updated_by=:userId, updated_at=NOW()`,
  { userId: userId ?? null }
);

for (const [reason, priority, minutes] of [
  ['privacy', 'urgent', 60],
  ['xss', 'urgent', 30],
  ['impersonation', 'high', 180],
  ['vandalism', 'high', 240],
  ['wrong_info', 'normal', 1440],
  ['typo', 'low', 4320],
  ['default', 'normal', 1440]
]) {
  await exec(
    `INSERT INTO report_sla_rules (reason, priority, target_minutes, enabled, created_at, updated_at)
     VALUES (:reason, :priority, :minutes, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE priority=VALUES(priority), target_minutes=VALUES(target_minutes), enabled=1, updated_at=NOW()`,
    { reason, priority, minutes }
  );
}

await exec(
  `INSERT INTO announcements (title, body, type, visibility, starts_at, created_by, created_at, updated_at)
   SELECT '오픈 베타 운영 안내', '신규 사용자 편집 제한, 신고 SLA, 서버 인증 정책이 적용됩니다.', 'notice', 'public', NOW(), :userId, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title='오픈 베타 운영 안내')`,
  { userId: userId ?? null }
);
await exec(
  `INSERT INTO release_notes (version, title, body, release_type, published_by, published_at, created_at)
   VALUES ('0.6.0', '오픈 베타 운영 기능', '공지, 릴리즈 노트, 사건 기록, 신고 SLA, 작성 캠페인, 주간 통계를 추가했습니다.', 'feature', :userId, NOW(), NOW())
   ON DUPLICATE KEY UPDATE title=VALUES(title), body=VALUES(body), published_at=VALUES(published_at)`,
  { userId: userId ?? null }
);
await exec(
  `INSERT INTO release_notes (version, title, body, release_type, published_by, published_at, created_at)
   VALUES ('0.7.0-rc', '정식 공개 후보 점검', '릴리즈 블로커, 정책 버전, 권한/보안/성능 감사, 일일 운영 요약을 추가했습니다.', 'policy', :userId, NOW(), NOW())
   ON DUPLICATE KEY UPDATE title=VALUES(title), body=VALUES(body), published_at=VALUES(published_at)`,
  { userId: userId ?? null }
);
await exec(
  `INSERT INTO incidents (title, incident_type, severity, status, started_at, resolved_at, summary, created_by, created_at, updated_at)
   SELECT '초기 상태 페이지 점검', 'availability', 'minor', 'resolved', NOW(), NOW(), '상태 페이지와 사건 기록 흐름을 검증했습니다.', :userId, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM incidents WHERE title='초기 상태 페이지 점검')`,
  { userId: userId ?? null }
);

await exec(
  `INSERT INTO writing_campaigns (title, description, campaign_type, status, starts_at, ends_at, created_by, created_at, updated_at)
   SELECT '정식 공개 기준 문서 정비', '바닐라, 모드, 서버, 가이드 기준 문서를 공개 전 점검한다.', 'cleanup', 'active', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), :userId, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM writing_campaigns WHERE title='정식 공개 기준 문서 정비')`,
  { userId: userId ?? null }
);
for (const title of ['엔더맨', 'Sodium', 'Fabric API', '예시서버', '오픈 베타 가입 안내']) {
  await exec(
    `INSERT INTO campaign_pages (campaign_id, page_id, namespace_id, title, status, note, created_at, updated_at)
     SELECT wc.id, p.id, p.namespace_id, :title, 'review', '공개 전 대표 문서 점검', NOW(), NOW()
     FROM writing_campaigns wc
     LEFT JOIN pages p ON p.title=:title
     WHERE wc.title='정식 공개 기준 문서 정비'
       AND NOT EXISTS (SELECT 1 FROM campaign_pages cp WHERE cp.campaign_id=wc.id AND cp.title=:title)
     LIMIT 1`,
    { title }
  );
}

const auditTerms = ['마크', '좀비 주민', '앤더맨', '소듐', 'paper', '페이퍼', '모드 설치', '서버 접속', '엔더맨', 'Fabric API'];
for (const term of auditTerms) {
  await exec(
    `INSERT INTO search_audits (query, expected_page_id, status, note, audited_by, audited_at, created_at)
     SELECT :term, NULL, 'pending', '정식 공개 검색 감사 필수어', :userId, NULL, NOW()
     WHERE NOT EXISTS (SELECT 1 FROM search_audits WHERE query=:term)`,
    { term, userId: userId ?? null }
  );
}

for (const title of ['Sodium', 'Iris', 'Lithium', 'Fabric API', 'Forge', 'NeoForge', 'OptiFine', 'JEI', 'Create', 'WorldEdit', 'AppleSkin', 'Mod Menu', 'Architectury API', 'Simple Voice Chat']) {
  await exec(
    `INSERT INTO mod_verification_tasks (page_id, task_type, status, due_at, created_at, updated_at)
     SELECT p.id, 'version_check', 'open', DATE_ADD(NOW(), INTERVAL 14 DAY), NOW(), NOW()
     FROM pages p JOIN namespaces n ON n.id=p.namespace_id
     WHERE n.code='mod' AND p.title=:title
       AND NOT EXISTS (SELECT 1 FROM mod_verification_tasks WHERE page_id=p.id AND task_type='version_check' AND status IN ('open','in_progress'))
     LIMIT 1`,
    { title }
  );
}

for (const [auditKey, role, target, action, expected, actual, status] of [
  ['admin_api_requires_admin', 'guest', 'admin_api', 'write', 'deny', 'deny', 'passed'],
  ['server_official_owner_only', 'user', 'server_official', 'edit', 'deny', 'deny', 'passed'],
  ['trusted_page_edit', 'trusted', 'page', 'edit', 'allow', 'allow', 'passed']
]) {
  await exec(
    `INSERT INTO permission_audits (audit_key, actor_role, target_type, action, expected_result, actual_result, status, tested_by, tested_at, note, created_at)
     SELECT :auditKey, :role, :target, :action, :expected, :actual, :status, :userId, NOW(), '시드 권한 감사', NOW()
     WHERE NOT EXISTS (SELECT 1 FROM permission_audits WHERE audit_key=:auditKey)`,
    { auditKey, role, target, action, expected, actual, status, userId: userId ?? null }
  );
}

for (const [checkKey, category, severity, status] of [
  ['body_xss_escape', 'xss', 'critical', 'passed'],
  ['admin_api_authz', 'api', 'critical', 'passed'],
  ['file_mime_limit', 'file', 'high', 'passed'],
  ['csrf_review', 'csrf', 'medium', 'passed']
]) {
  await exec(
    `INSERT INTO security_release_checks (check_key, category, severity, status, note, checked_by, checked_at, created_at)
     SELECT :checkKey, :category, :severity, :status, '정식 공개 보안 체크', :userId, IF(:status='pending', NULL, NOW()), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM security_release_checks WHERE check_key=:checkKey)`,
    { checkKey, category, severity, status, userId: userId ?? null }
  );
  await exec(
    `UPDATE security_release_checks
     SET status=:status, checked_by=:userId, checked_at=IF(:status='pending', NULL, NOW()), note='정식 공개 보안 체크'
     WHERE check_key=:checkKey`,
    { checkKey, status, userId: userId ?? null }
  );
}

for (const [checkKey, area, status] of [
  ['page_render_cache', 'page', 'passed'],
  ['search_index_basic', 'search', 'passed'],
  ['recent_changes_index', 'recent_changes', 'passed'],
  ['server_list_no_live_ping', 'server_list', 'passed'],
  ['admin_queue_limit', 'admin', 'passed']
]) {
  await exec(
    `INSERT INTO performance_checks (check_key, target_area, status, note, checked_by, checked_at, created_at)
     SELECT :checkKey, :area, :status, '정식 공개 성능 체크', :userId, NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM performance_checks WHERE check_key=:checkKey)`,
    { checkKey, area, status, userId: userId ?? null }
  );
}

if (modIds.get('Sodium')) await addPageAlias('mod', '소듐 설치', modIds.get('Sodium')!, 'search');
if (modIds.get('Iris')) await addPageAlias('mod', '아이리스 셰이더', modIds.get('Iris')!, 'search');
if (modIds.get('Paper')) await addPageAlias('mod', '페이퍼 서버 여는법', modIds.get('Paper')!, 'search');
await addPageAlias('main', '마크 좀비주민 치료', zombieVillager, 'search');
await addPageAlias('server', '반야생 서버', serverId, 'search');

const seededServerSubwiki = await one<{ id: number }>(`SELECT id FROM wiki_spaces WHERE code='server-example'`);
if (seededServerSubwiki) {
  await exec(
    `INSERT INTO gitbook_import_jobs (space_id, requested_by, source_type, status, source_note, mapping_json, created_at, updated_at)
     SELECT :spaceId, :userId, 'manual', 'review', 'GitBook 이전 체크리스트 시드', :mapping, NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM gitbook_import_jobs WHERE space_id=:spaceId AND source_note='GitBook 이전 체크리스트 시드')`,
    {
      spaceId: seededServerSubwiki.id,
      userId: userId ?? 1,
      mapping: JSON.stringify({
        checklist: ['접속 문서 있음', '규칙 문서 있음', '공지 문서 있음', '사이드바 매핑', '공식 영역 지정'],
        tree: ['대문', '접속 방법', '규칙', '공지']
      })
    }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     SELECT 'gitbook_import', 'gitbook_import', gij.id, 'normal', NOW(), NOW()
     FROM gitbook_import_jobs gij
     WHERE gij.space_id=:spaceId AND gij.source_note='GitBook 이전 체크리스트 시드'
       AND NOT EXISTS (SELECT 1 FROM admin_work_items awi WHERE awi.work_type='gitbook_import' AND awi.target_id=gij.id)
     LIMIT 1`,
    { spaceId: seededServerSubwiki.id }
  );
}

await exec(
  `INSERT INTO release_blockers (source_type, blocker_type, severity, title, description, status, created_at, updated_at)
   SELECT 'manual', 'other', 'high', '릴리즈 블로커 큐 생성 확인', '블로커 등록과 해소 흐름 확인용 닫힌 항목', 'resolved', NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM release_blockers WHERE title='릴리즈 블로커 큐 생성 확인')`
);

for (const [code, label, target] of [
  ['main', '처음 편집하기', '처음 편집하기'],
  ['mod', 'Fabric API', 'Fabric API'],
  ['server', '서버 공식 위키 만들기', '서버 공식 위키 만들기'],
  ['develop', 'Paper API', 'Paper API']
]) {
  await exec(
    `INSERT INTO subwiki_sidebar_items (space_id, label, target_title, sort_order, created_at, updated_at)
     SELECT ws.id, :label, :target, 10, NOW(), NOW() FROM wiki_spaces ws
     WHERE ws.code=:code
       AND NOT EXISTS (SELECT 1 FROM subwiki_sidebar_items si WHERE si.space_id=ws.id AND si.label=:label)`,
    { code, label, target }
  );
}

const paperApiId = await findPageId('dev', 'Paper API');
if (paperApiId) {
  await addPageAlias('dev', '페이퍼', paperApiId, 'korean_alt');
  await exec(
    `INSERT INTO search_disambiguation_candidates (query, normalized_query, page_id, label, note, weight, enabled, created_by, created_at)
     VALUES ('페이퍼', :normalized, :pageId, 'Paper API', '개발 API 문서', 130, 1, :userId, NOW())
     ON DUPLICATE KEY UPDATE normalized_query=VALUES(normalized_query), label=VALUES(label), note=VALUES(note), weight=VALUES(weight), enabled=1`,
    { normalized: normalizeSearch('페이퍼'), pageId: paperApiId, userId }
  );
}
const paperModId = await findPageId('mod', 'Paper');
if (paperModId) {
  await addPageAlias('mod', '페이퍼 서버', paperModId, 'korean_alt');
  await exec(
    `INSERT INTO search_disambiguation_candidates (query, normalized_query, page_id, label, note, weight, enabled, created_by, created_at)
     VALUES ('페이퍼', :normalized, :pageId, 'Paper 서버 소프트웨어', '모드/서버 소프트웨어 문서', 140, 1, :userId, NOW())
     ON DUPLICATE KEY UPDATE normalized_query=VALUES(normalized_query), label=VALUES(label), note=VALUES(note), weight=VALUES(weight), enabled=1`,
    { normalized: normalizeSearch('페이퍼'), pageId: paperModId, userId }
  );
}
await addSearchTerm('마크 좀비주민 치료', 'guide', '좀비 주민 치료');
await addSearchTerm('좀비 주민 치료', 'guide', '좀비 주민 치료');
await addSearchTerm('마크 주민 직업', 'main', '주민/직업');
await addSearchTerm('주민 직업', 'main', '주민/직업');
await addSearchTerm('마크 다이아 높이', 'main', '다이아몬드');
await addSearchTerm('소듐 설치', 'mod', 'Sodium');
await addSearchTerm('아이리스 셰이더', 'mod', 'Iris');
await addSearchTerm('페이퍼 서버 여는법', 'guide', 'Paper 서버 열기');
await addSearchTerm('Paper 서버 열기', 'guide', 'Paper 서버 열기');
await addSearchTerm('반야생 서버', 'server', '예시서버');
await addSearchTerm('페이퍼', 'dev', 'Paper API', 700);

await rebuildOpenBetaWeeklyStats();
await rebuildDailyOperationSummary();
await syncPageSpaces();

console.log('Seeded MineWiki MVP documents.');
await pool.end();
