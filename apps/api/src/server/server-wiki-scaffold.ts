import type { Prisma } from '@prisma/client';

export interface ServerWikiScaffoldInput {
  readonly name: string;
  readonly joinHost: string;
  readonly joinPort: number;
  readonly edition: string;
  readonly supportedVersions: Prisma.JsonValue;
  readonly tags: Prisma.JsonValue;
  readonly shortDescription?: string | null;
  readonly longDescription: string;
  readonly websiteUrl?: string | null;
  readonly discordUrl?: string | null;
}

export interface ServerWikiStarterPage {
  readonly path: string;
  readonly title: string;
  readonly contentRaw: string;
}

export function buildServerWikiMainPage(server: ServerWikiScaffoldInput): string {
  const versions = normalizeStringArray(server.supportedVersions);
  const tags = normalizeStringArray(server.tags);
  const address = formatAddress(server.joinHost, server.joinPort);
  const introduction =
    server.longDescription.trim() ||
    server.shortDescription?.trim() ||
    `${server.name} 운영자가 서버 소개를 아직 작성하지 않았습니다.`;

  return joinLines([
    `= ${server.name} =`,
    '',
    '== 서버 소개 ==',
    introduction,
    '',
    '== 빠른 접속 정보 ==',
    `* 접속 주소: ${address}`,
    `* 에디션: ${formatEdition(server.edition)}`,
    versions.length > 0
      ? `* 지원 버전: ${versions.join(', ')}`
      : '* 지원 버전: 운영자가 아직 등록하지 않았습니다.',
    '',
    '== 처음 방문자를 위한 순서 ==',
    '* [[시작하기]]에서 서버 추가 방법과 접속 전 확인 사항을 살펴보세요.',
    '* 접속 전에 [[규칙]]에서 공식 운영 정책의 작성 상태를 확인하세요.',
    '* 접속 문제가 생기면 [[FAQ]]의 점검 순서를 따라가세요.',
    '',
    '== 주요 콘텐츠 ==',
    tags.length > 0
      ? `* 등록된 태그: ${tags.join(', ')}`
      : '* 운영자가 주요 콘텐츠와 플레이 방식을 아직 등록하지 않았습니다.',
    '',
    '== 공식 채널 ==',
    ...buildContactLines(server),
    '',
    '== 문서 이용 안내 ==',
    `이 문서 공간은 ${server.name}의 접속 정보, 규칙, 자주 묻는 질문을 문서별로 관리합니다. 각 문서의 최근 수정 시각과 역사를 확인해 정보가 최신인지 판단할 수 있습니다.`,
    '',
  ]);
}

export function buildServerWikiStarterPages(
  server: ServerWikiScaffoldInput,
): ReadonlyArray<ServerWikiStarterPage> {
  const address = formatAddress(server.joinHost, server.joinPort);
  const versions = normalizeStringArray(server.supportedVersions);
  const versionLabel =
    versions.length > 0 ? versions.join(', ') : '운영자가 아직 지원 버전을 등록하지 않았습니다.';
  const contacts = buildContactLines(server);

  return [
    {
      path: '시작하기',
      title: '시작하기',
      contentRaw: joinLines([
        `= ${server.name} 시작하기 =`,
        '',
        '== 접속 전 확인 ==',
        `* 에디션: ${formatEdition(server.edition)}`,
        `* 지원 버전: ${versionLabel}`,
        `* 접속 주소: ${address}`,
        '',
        '== 서버 추가 순서 ==',
        '* Minecraft를 실행하고 멀티플레이 메뉴를 여세요.',
        '* 서버 추가를 선택한 뒤 위 접속 주소를 그대로 입력하세요.',
        '* 목록에 저장된 서버를 선택해 접속하세요.',
        '* 접속 전 [[규칙]]의 작성 상태와 운영자 공지를 확인하세요.',
        '',
        '== 접속되지 않을 때 ==',
        '* 에디션과 게임 버전이 위 정보와 일치하는지 확인하세요.',
        '* 주소 앞뒤의 공백과 오타를 확인하세요.',
        '* 서버 상세의 온라인 상태와 공식 채널 공지를 확인하세요.',
        '* 문제가 계속되면 [[FAQ]]에서 문의 경로를 확인하세요.',
        '',
      ]),
    },
    {
      path: '규칙',
      title: '서버 규칙',
      contentRaw: joinLines([
        '= 서버 규칙 =',
        '',
        '== 작성 상태 ==',
        `'''${server.name} 운영자가 공식 서버 규칙을 아직 작성하지 않았습니다.''' 접속 전 서버 내 공지와 공식 채널의 최신 안내를 먼저 확인하세요.`,
        '',
        '== 운영자 작성 체크리스트 ==',
        '* 허용·금지되는 플레이 방식',
        '* 채팅과 커뮤니티 이용 기준',
        '* 거래, 경제, 아이템 관련 정책',
        '* 제재 단계와 이의 제기 방법',
        '* 규칙 변경 공지와 시행 시점',
        '',
        '이 체크리스트는 규칙 자체가 아니며, 운영자가 실제 정책으로 교체해야 합니다.',
        '',
      ]),
    },
    {
      path: 'FAQ',
      title: '자주 묻는 질문',
      contentRaw: joinLines([
        '= 자주 묻는 질문 =',
        '',
        '== 서버 주소는 무엇인가요? ==',
        address,
        '',
        '== 어떤 버전으로 접속하나요? ==',
        versionLabel,
        '',
        '== 처음 접속하려면 어떻게 하나요? ==',
        '[[시작하기]] 문서의 서버 추가 순서를 확인하세요.',
        '',
        '== 접속 오류가 발생합니다 ==',
        '에디션, 버전, 주소를 차례로 확인한 뒤 서버 상세의 온라인 상태와 공식 공지를 확인하세요.',
        '',
        '== 어디로 문의하나요? ==',
        ...contacts,
        '',
        '공식 채널이 등록되지 않았다면 서버 상세의 정보가 갱신될 때까지 기다리거나 MineWiki 고객센터에서 등록 정보 문제를 알려 주세요.',
        '',
      ]),
    },
  ];
}

function buildContactLines(
  server: Pick<ServerWikiScaffoldInput, 'websiteUrl' | 'discordUrl'>,
): string[] {
  const contacts = [
    server.websiteUrl ? `* 공식 홈페이지: ${server.websiteUrl}` : null,
    server.discordUrl ? `* 공식 Discord: ${server.discordUrl}` : null,
  ].filter((line): line is string => Boolean(line));
  return contacts.length > 0
    ? contacts
    : ['* 등록된 공식 홈페이지와 Discord 링크가 아직 없습니다.'];
}

function formatAddress(host: string, port: number): string {
  return `${host}:${port}`;
}

function formatEdition(edition: string): string {
  if (edition === 'java') return 'Java Edition';
  if (edition === 'bedrock') return 'Bedrock Edition';
  return edition;
}

function normalizeStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}
