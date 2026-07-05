맞아요. 현재 화면은 “나무위키 계열 위키”라기보다 카드형 문서 포털과 관리자 UI를 섞은 모습에 가깝습니다. 콘텐츠나 기능보다 레이아웃과 CSS 누적 구조가 문제입니다.

코드에서 확인한 핵심 원인

1. 스킨이 하나가 아니라 여러 디자인이 겹쳐 있습니다

layout.ts에서 app.css와 wiki-skin.css를 동시에 불러옵니다. app.css만 해도 4,685줄이고, 두 파일에서 .topbar, .wiki-shell, .article, .wiki-sidebar, .article-toc 같은 핵심 선택자를 반복해서 재정의합니다. 결국 하나의 디자인 시스템이 아니라 마지막에 선언된 CSS가 이전 CSS를 덮어쓰는 구조입니다.  

이 상태에서 새 스킨을 또 덮어쓰면 잠깐 나아 보여도 계속 망가집니다. 특히 현재 코드에는 한국형 위키, Liberty 계열, 카드 UI, 다크모드 보정 등이 한꺼번에 남아 있어 색상·간격·모서리·버튼 스타일이 일관되지 않습니다.

가장 먼저 해야 할 일은 새 CSS 추가가 아니라 기존 스킨 레이어 정리입니다.

⸻

2. 본문보다 주변 UI가 더 강합니다

현재 문서 페이지에는 다음 요소가 동시에 존재합니다.

* 상단 헤더
* 헤더 아래 page-intent-strip
* 왼쪽 사이드바
* 문서 제목과 액션 버튼
* 문서 탭
* 오른쪽 목차

page-intent-strip은 페이지 제목과 바로가기 링크를 다시 표시하며, 문서 레이아웃과 별도로 모든 페이지에 삽입됩니다. 사실상 동일한 탐색 정보를 두세 번 반복하고 있습니다.  

나무위키스럽게 보이려면 가장 먼저 보여야 하는 것은 문서 제목과 본문입니다. 지금은 문서를 읽기 전에 서비스 UI를 여러 겹 통과해야 합니다.

문서 페이지에서는 page-intent-strip을 없애는 것이 좋습니다.

⸻

3. 데스크톱에서도 본문이 너무 좁습니다

현재 최종 스킨의 문서 그리드는 다음 구조입니다.

grid-template-columns: 220px minmax(0, 1fr) 240px;

전체 콘텐츠 폭 안에서 왼쪽 사이드바 220px, 오른쪽 목차 240px를 고정으로 사용합니다. 간격까지 제외하면 실제 문서 폭은 대략 700px 수준입니다.  

이 때문에 화면은 넓어도 다음과 같이 보입니다.

[왼쪽 메뉴] [좁은 문서] [오른쪽 목차]

위키에서는 반대로 되어야 합니다.

[보조 메뉴] [넓고 지배적인 문서 영역]

오른쪽 목차는 1500px 이상의 초대형 화면에서만 나타나게 하거나, 문서 상단의 접이식 목차로 넣는 편이 낫습니다.

⸻

4. 문서가 아니라 카드 모음처럼 보입니다

현재 대문은 각 섹션이 별도 배경, 테두리, 둥근 모서리, 패딩을 가진 카드처럼 보입니다. 문서 제목과 액션도 강조 박스와 버튼 형태가 강합니다.

이 스타일은 대시보드에는 적합하지만 위키에서는 페이지가 여러 조각으로 끊겨 보이게 합니다.

나무위키형 시각 언어의 핵심은 다음에 가깝습니다.

* 흰색 문서 한 장
* 얇은 회색 테두리
* 거의 없는 그림자
* 0~2px 정도의 작은 radius
* 제목 아래 구분선
* 본문 안에서 연속되는 섹션
* 링크와 표를 통한 높은 정보 밀도

즉, 카드 디자인을 예쁘게 다듬는 것이 아니라 카드 자체를 대부분 제거해야 합니다.

⸻

5. 문서 액션과 탐색 구조도 분산되어 있습니다

현재 문서 페이지는 제목 영역, 문서 모드 탭, 도구 링크가 서로 다른 위치와 표현 방식으로 나뉘어 있습니다. 왼쪽 사이드바에는 최근 변경과 탐색 링크가 함께 들어갑니다.  

다음처럼 정리하는 편이 자연스럽습니다.

문서 제목
설명 / 최근 수정 정보
[문서] [토론] [편집] [역사] [도구]
목차
1. 개요
2. 특징
3. ...
────────────────────────
본문

버튼을 각각 독립적인 카드로 만들기보다 한 줄짜리 문서 탭으로 보여주는 것이 좋습니다.

⸻

권장 레이아웃

데스크톱

┌────────────────────────────────────────────────────────────┐
│ 로고   최근 변경   랜덤 문서       검색창       로그인     │
└────────────────────────────────────────────────────────────┘
       ┌─────────────┐ ┌───────────────────────────────────┐
       │ 최근 변경   │ │ 문서 제목                          │
       │ 주요 문서   │ │ 문서 · 토론 · 편집 · 역사          │
       │ 분류        │ ├───────────────────────────────────┤
       │             │ │ 목차                               │
       │             │ │                                   │
       │             │ │ 본문                               │
       └─────────────┘ └───────────────────────────────────┘

추천 수치:

* 전체 폭: 1280px ~ 1360px
* 왼쪽 사이드바: 210px ~ 220px
* 본문: 최소 900px, 가능하면 1000px 이상
* 열 간격: 14px ~ 16px
* 오른쪽 고정 목차: 기본적으로 제거
* 문서 패딩: 좌우 24px
* 본문 글자: 15px ~ 16px
* 본문 줄 간격: 1.65 ~ 1.75

모바일

* 사이드바 완전 숨김
* 오른쪽 목차 숨김
* 제목 아래 접이식 목차 배치
* 헤더에는 로고, 검색, 메뉴 버튼만 표시
* 문서 전체 폭 사용
* 카드 중첩 금지

현재 DOM은 사이드바, 문서, 목차 순서로 구성되어 있어 단순히 한 열로 바꾸면 긴 문서 뒤에 목차와 사이드바가 이어질 가능성이 큽니다. 모바일에서는 CSS 순서 변경보다 목차를 문서 내부로 이동하는 구조 변경이 안전합니다.  

⸻

우선 적용할 CSS 방향

아래 정도로 바꾸면 현재보다 훨씬 위키다운 인상이 납니다.

:root {
  --wiki-background: #eef0f2;
  --wiki-surface: #ffffff;
  --wiki-border: #d5d8dc;
  --wiki-text: #212529;
  --wiki-muted: #6b7280;
  --wiki-link: #0275d8;
  --wiki-brand: #008275;
  --wiki-brand-hover: #006f64;
  --wiki-radius: 2px;
}
/* 상단은 하나의 단단한 내비게이션으로 */
.topbar:not(.admin-topbar) {
  min-height: 48px;
  background: var(--wiki-brand);
  box-shadow: none;
  border: 0;
}
/* 문서 페이지에서 중복되는 보조 바 제거 */
.skin-article + .page-intent-strip,
body:has(.skin-article) .page-intent-strip {
  display: none;
}
/* 오른쪽 목차를 제외한 2열 구조 */
.wiki-shell.skin-article {
  width: min(1320px, calc(100% - 32px));
  margin-inline: auto;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.skin-article .wiki-sidebar {
  grid-column: 1;
}
.skin-article .article {
  grid-column: 2;
  min-width: 0;
}
.skin-article > .article-toc {
  display: none;
}
/* 한 장의 문서처럼 표현 */
.article {
  background: var(--wiki-surface);
  border: 1px solid var(--wiki-border);
  border-radius: 0;
  box-shadow: none;
}
.article-head {
  padding: 20px 24px 12px;
  border: 0;
  border-bottom: 1px solid var(--wiki-border);
  background: transparent;
}
.article h1 {
  display: block;
  margin: 0;
  padding: 0;
  font-size: 2rem;
  line-height: 1.25;
  background: transparent;
  box-shadow: none;
}
.article-main {
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.article-body {
  padding: 20px 24px 40px;
  color: var(--wiki-text);
  font-size: 15.5px;
  line-height: 1.7;
}
.article-body h2 {
  margin: 2.2rem 0 0.8rem;
  padding: 0 0 0.35rem;
  border: 0;
  border-bottom: 1px solid var(--wiki-border);
  background: transparent;
  box-shadow: none;
  font-size: 1.45rem;
}
/* 대문 섹션의 카드 느낌 제거 */
.front-page .article-body section,
.front-page .article-body h2 + p,
.front-page .article-body h2 + ul {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
/* 액션을 버튼보다는 문서 탭처럼 */
.article-actions {
  display: flex;
  gap: 0;
  margin-top: 14px;
  border-bottom: 1px solid var(--wiki-border);
}
.article-actions a,
.article-actions button {
  min-height: 34px;
  padding: 7px 11px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.article-actions .active {
  border-bottom: 2px solid var(--wiki-brand);
  font-weight: 700;
}
/* 모바일 */
@media (max-width: 900px) {
  .wiki-shell.skin-article {
    display: block;
    width: 100%;
    padding: 0;
  }
  .skin-article .wiki-sidebar,
  .skin-article > .article-toc {
    display: none;
  }
  .article {
    border-inline: 0;
  }
  .article-head {
    padding: 16px;
  }
  .article-body {
    padding: 16px 16px 32px;
  }
  .article h1 {
    font-size: 1.65rem;
  }
}

body:has() 방식은 임시 조치입니다. 실제 코드에서는 layout.ts가 문서 페이지일 때 page-intent-strip 자체를 출력하지 않도록 하는 것이 좋습니다.

⸻

layout.ts에서 바꿔야 할 부분

현재는 레이아웃 마지막 조립 단계에서 ${intentStrip}을 그대로 삽입합니다.  

레이아웃 옵션을 하나 추가하는 방식이 깔끔합니다.

interface LayoutOptions {
  // 기존 옵션...
  hideIntentStrip?: boolean;
}
const intentStripHtml = options.hideIntentStrip
  ? ""
  : pageIntentStrip({
      contextLabel,
      pageTitle,
      shortcuts,
    });
<body>
  ${topbar}
  ${intentStripHtml}
  ${body}
  ${footer}
</body>

문서 페이지에서는:

return renderLayout({
  ...options,
  hideIntentStrip: true,
  body: articleMarkup,
});

관리 페이지나 특수 페이지에서만 intent strip을 유지하면 됩니다.

⸻

CSS 구조는 이렇게 정리해야 합니다

현재처럼 app.css와 wiki-skin.css 뒤쪽에 계속 override를 추가하는 방식은 중단하는 것이 좋습니다.

public/styles/
├── tokens.css          색상, 크기, 간격 변수
├── base.css            reset, typography
├── layout.css          topbar, shell, sidebar
├── article.css         제목, 목차, 표, 인용문
├── components.css      버튼, 탭, 입력창
├── pages/
│   ├── front-page.css
│   ├── search.css
│   └── history.css
└── admin.css

중요한 규칙은 세 가지입니다.

1. 동일 선택자를 서로 다른 파일에서 반복해서 정의하지 않기
2. !important로 테마를 덮어쓰지 않기
3. 공개 위키와 관리자 화면의 컴포넌트 스타일을 분리하기

결론

전체 애플리케이션을 다시 만들 필요는 없습니다. 문서 구조와 주요 기능은 이미 위키 형태로 구성되어 있습니다.  

가장 효과가 큰 수정 순서는 다음입니다.

1. 문서 페이지의 page-intent-strip 제거
2. 오른쪽 고정 목차 제거
3. 본문 폭을 900px 이상으로 확대
4. 대문의 카드·그림자·둥근 모서리 제거
5. 문서 액션을 한 줄 탭으로 통합
6. app.css와 wiki-skin.css의 중복 override 정리

현재 디자인의 핵심 문제는 색상이 아니라 문서보다 UI가 앞에 나오는 것입니다. 문서 한 장을 중심으로 구조를 다시 잡으면 훨씬 명확하게 “위키 같다”는 인상이 납니다.
