#!/usr/bin/env node

import './load-environment.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const prisma = new PrismaClient();
const changes = [];
const now = () => new Date();

const namespaces = [
  { code: 'main', displayName: '일반', pathPrefix: '/wiki', isContent: true },
  { code: 'mod', displayName: '모드', pathPrefix: '/wiki/모드', isContent: true },
  { code: 'modpack', displayName: '모드팩', pathPrefix: '/wiki/모드팩', isContent: true },
  { code: 'server', displayName: '서버', pathPrefix: '/wiki/서버', isContent: true },
  { code: 'dev', displayName: '개발', pathPrefix: '/dev', isContent: true },
  { code: 'guide', displayName: '가이드', pathPrefix: '/wiki/가이드', isContent: true },
  { code: 'data', displayName: '데이터', pathPrefix: '/wiki/데이터', isContent: true },
  { code: 'help', displayName: '도움말', pathPrefix: '/wiki/도움말', isContent: false },
  { code: 'project', displayName: '프로젝트', pathPrefix: '/wiki/프로젝트', isContent: false },
  { code: 'template', displayName: '틀', pathPrefix: '/wiki/틀', isContent: false },
  { code: 'user', displayName: '사용자', pathPrefix: '/user', isContent: false },
  { code: 'category', displayName: '분류', pathPrefix: '/wiki/category', isContent: false },
  { code: 'file', displayName: '파일', pathPrefix: '/file', isContent: false },
];

const rootSpaces = [
  {
    code: 'main',
    spaceKey: 'main',
    name: 'MineWiki',
    title: 'MineWiki',
    rootNamespaceCode: 'main',
    rootPath: '/wiki',
    description: 'MineWiki 기본 위키 공간',
    pagePath: '/wiki/대문',
    pageTitle: '대문',
    content: `{{대문 소개|제목=MineWiki|설명=마인크래프트 지식과 서버 정보를 함께 정리하는 통합 위키입니다.}}

{{대문 검색|예시=블록, 명령어, 서버 이름 검색}}

{{대문 카드|제목=서버 찾기|설명=인증된 서버와 투표 순위를 확인하세요.|링크=/servers}}
{{대문 카드|제목=도움말|설명=편집과 계정 사용법을 확인하세요.|링크=/help/대문}}`,
  },
  {
    code: 'category',
    spaceKey: 'category',
    name: '분류',
    title: '분류',
    rootNamespaceCode: 'category',
    rootPath: '/wiki/category',
    description: '위키 분류 문서와 상하위 분류 계층',
    pagePath: '/wiki/category/분류',
    pageTitle: '분류',
    content: `== 분류 ==

MineWiki 분류 계층의 루트 문서입니다. 하위 분류 문서는 이 분류를 상위 분류로 지정할 수 있습니다.

분류 문서에는 분류의 범위와 포함 기준을 설명해 주세요.`,
  },
  {
    code: 'mod',
    spaceKey: 'mod',
    name: '모드',
    title: '마인크래프트 모드',
    rootNamespaceCode: 'mod',
    rootPath: '/mod',
    description: '마인크래프트 모드별 설치, 기능, 장치와 호환성 문서',
    pagePath: '/mod/대문',
    pageTitle: '대문',
    content: `== 마인크래프트 모드 ==

모드의 설치 방법, 주요 기능, 장치, 설정과 버전별 호환성을 정리하는 공간입니다.

* 모드 이름과 지원하는 마인크래프트 버전을 함께 기록합니다.
* 로더와 필수 의존성, 서버·클라이언트 설치 여부를 구분합니다.
* 확인되지 않은 내용은 검증 필요 상태로 표시합니다.`,
  },
  {
    code: 'modpack',
    spaceKey: 'modpack',
    name: '모드팩',
    title: '마인크래프트 모드팩',
    rootNamespaceCode: 'modpack',
    rootPath: '/modpack',
    description: '모드팩 설치, 진행, 서버 운영과 문제 해결 문서',
    pagePath: '/modpack/대문',
    pageTitle: '대문',
    content: `== 마인크래프트 모드팩 ==

모드팩별 설치 방법, 권장 사양, 진행 순서와 서버 운영 정보를 정리하는 공간입니다.

문서에는 배포처, 모드팩 버전, 마인크래프트 버전과 필요한 메모리를 명확하게 기록해 주세요.`,
  },
  {
    code: 'develop',
    spaceKey: 'develop',
    name: '개발',
    title: '마인크래프트 개발',
    rootNamespaceCode: 'dev',
    rootPath: '/dev',
    description: '플러그인, 모드, 프로토콜과 서버 개발 문서',
    pagePath: '/dev/대문',
    pageTitle: '대문',
    content: `== 마인크래프트 개발 ==

Paper, Fabric, 데이터팩, 네트워크 프로토콜과 서버 자동화 정보를 정리하는 개발 문서 공간입니다.

* API 또는 프로토콜 버전과 공식 출처를 함께 남깁니다.
* 예제 코드는 실행 환경과 의존성을 명시합니다.
* 보안에 민감한 토큰과 운영 비밀은 문서에 기록하지 않습니다.`,
  },
  {
    code: 'guide',
    spaceKey: 'guide',
    name: '가이드',
    title: '마인크래프트 가이드',
    rootNamespaceCode: 'guide',
    rootPath: '/guide',
    description: '플레이와 서버 이용을 위한 단계별 안내 문서',
    pagePath: '/guide/대문',
    pageTitle: '대문',
    content: `== 마인크래프트 가이드 ==

처음 시작하는 플레이어부터 서버 운영자까지 따라 할 수 있는 단계별 안내를 정리합니다.

각 가이드는 준비물, 절차, 확인 방법과 관련 문서를 포함하는 것을 권장합니다.`,
  },
  {
    code: 'data',
    spaceKey: 'data',
    name: '데이터',
    title: '마인크래프트 데이터',
    rootNamespaceCode: 'data',
    rootPath: '/data',
    description: '버전, 식별자와 구조화된 마인크래프트 데이터 문서',
    pagePath: '/data/대문',
    pageTitle: '대문',
    content: `== 마인크래프트 데이터 ==

블록, 아이템, 엔티티, 레지스트리와 버전별 식별자처럼 구조화된 정보를 정리하는 공간입니다.

데이터를 추가할 때는 기준 게임 버전과 원본 출처를 함께 표시해 주세요.`,
  },
  {
    code: 'template',
    spaceKey: 'template',
    name: '틀',
    title: '위키 틀',
    rootNamespaceCode: 'template',
    rootPath: '/template',
    description: 'MineWiki 문서에서 재사용하는 틀과 사용법',
    pagePath: '/template/대문',
    pageTitle: '대문',
    content: `== 위키 틀 ==

여러 문서에서 재사용하는 정보 상자와 안내 문구를 관리하는 공간입니다.

틀을 변경하기 전에는 사용하는 문서와 매개변수 호환성을 확인해 주세요.`,
  },
  {
    code: 'file',
    spaceKey: 'file',
    name: '파일',
    title: '위키 파일',
    rootNamespaceCode: 'file',
    rootPath: '/file',
    description: '위키에서 사용하는 이미지와 파일의 라이선스 안내',
    pagePath: '/file/대문',
    pageTitle: '대문',
    content: `== 위키 파일 ==

문서에 사용하는 이미지와 파일은 출처, 작성자와 라이선스 정보를 포함해야 합니다.

개인정보, 비밀키, 서버 토큰 또는 재배포 권한이 없는 파일은 업로드하지 마세요.`,
  },
  {
    code: 'help',
    spaceKey: 'help',
    name: '도움말',
    title: '도움말',
    rootNamespaceCode: 'help',
    rootPath: '/help',
    description: 'MineWiki 도움말 공간',
    pagePath: '/help/대문',
    pageTitle: '대문',
    content: `== 도움말 ==

MineWiki 사용법과 편집 안내를 정리하는 공간입니다.

* 계정을 만들고 로그인합니다.
* 문서를 검색하거나 새 문서를 작성합니다.
* 서버 소유자는 서버 상세 페이지에서 서버 위키를 연결할 수 있습니다.`,
  },
  {
    code: 'project',
    spaceKey: 'project',
    name: '프로젝트',
    title: '프로젝트',
    rootNamespaceCode: 'project',
    rootPath: '/project',
    description: 'MineWiki 운영 프로젝트 공간',
    pagePath: '/project/대문',
    pageTitle: '대문',
    content: `== MineWiki 프로젝트 ==

운영 정책, 공지, 개선 계획을 정리하는 프로젝트 공간입니다.

* 배포 전 \`pnpm data:validate\`를 실행합니다.
* 배포 후 \`pnpm smoke\`로 주요 경로를 확인합니다.`,
  },
];

const roles = [
  ['owner', 'Owner', 'Full site owner'],
  ['admin', 'Admin', 'Full site administrator'],
  ['moderator', 'Moderator', 'Moderation staff'],
  ['wiki_admin', 'Wiki Admin', 'Wiki administrator'],
  ['server_admin', 'Server Admin', 'Server administrator'],
  ['vote_moderator', 'Vote Moderator', 'Vote integrity moderator'],
  ['support_agent', 'Support Agent', 'Support staff'],
];

const permissions = [
  ['wiki.read.restricted', 'Read restricted wiki resources'],
  ['wiki.edit.locked', 'Edit locked wiki pages'],
  ['wiki.admin', 'Manage wiki administration'],
  ['wiki.acl.manage', 'Manage wiki ACL groups and memberships'],
  ['wiki.user.block', 'Block and unblock wiki contributors'],
  ['wiki.batch_rollback', 'Preview and execute bounded wiki vandalism rollback'],
  ['wiki.report.moderate', 'Moderate aggregated wiki abuse reports'],
  ['server.admin', 'Manage server administration'],
  ['review.moderate', 'Moderate review reports and review visibility'],
  ['vote.admin', 'Invalidate abusive votes and manage vote integrity'],
  ['guild.admin', 'Manage Discord guild administration'],
  ['support.admin', 'Manage support tickets'],
  ['file.admin', 'Manage uploaded files'],
  ['admin.account.delete', 'Process account termination lifecycle requests'],
  ['admin.account.suspend', 'Emergency suspend and restore canonical account groups'],
];

const rolePermissions = {
  owner: permissions.map(([code]) => code),
  admin: permissions.map(([code]) => code),
  wiki_admin: ['wiki.admin', 'wiki.acl.manage', 'wiki.edit.locked', 'wiki.read.restricted', 'wiki.user.block', 'wiki.batch_rollback', 'wiki.report.moderate'],
  server_admin: ['server.admin', 'review.moderate'],
  vote_moderator: ['vote.admin'],
  support_agent: ['support.admin'],
  moderator: ['wiki.edit.locked', 'wiki.read.restricted', 'wiki.user.block', 'wiki.batch_rollback', 'wiki.report.moderate', 'review.moderate'],
};

const siteSettings = [
  ['site.name', 'MineWiki', 'Public site name'],
  ['site.locale', 'ko-KR', 'Default locale'],
  ['wiki.frontPage', '/wiki/대문', 'Default wiki front page'],
  ['help.frontPage', '/help/대문', 'Default help front page'],
  ['project.frontPage', '/project/대문', 'Default project front page'],
  ['registration.enabled', true, 'Whether public account registration is enabled'],
  ['support.enabled', true, 'Whether support ticket features are enabled'],
];

const documentTemplates = [
  {
    key: 'guide', title: '가이드 문서', description: '개요, 준비물, 절차, 관련 문서 구조로 시작합니다.', targetArea: 'any', category: '가이드',
    content: `{{문서 상태
|상태=검증 필요
}}

'''{{문서명}}''' 가이드입니다.

== 개요 ==

== 준비물 ==

== 절차 ==

== 관련 문서 ==`
  },
  {
    key: 'server_rules', title: '서버 규칙', description: '서버 규칙과 제재 기준을 일관된 구조로 정리합니다.', targetArea: 'official', category: '서버 규칙',
    content: `{{문서 상태
|상태=검증 필요
}}

'''{{문서명}}''' 문서입니다.

== 기본 규칙 ==

== 금지 행위 ==

== 제재 기준 ==

== 이의 제기 ==`
  },
  {
    key: 'server_notice', title: '서버 공지', description: '공지 내용, 적용 일시, 영향을 빠짐없이 기록합니다.', targetArea: 'official', category: '서버 공지',
    content: `{{문서 상태
|상태=공식
}}

== 공지 내용 ==

== 적용 일시 ==

== 영향 및 유의사항 ==`
  },
  {
    key: 'mod_device', title: '모드 장치', description: '모드 장치의 제작법과 사용법, 자동화 예시를 작성합니다.', targetArea: 'any', category: '모드 장치',
    content: `{{문서 상태
|상태=검증 필요
}}

'''{{문서명}}'''은 모드에서 제공하는 장치입니다.

== 개요 ==

== 제작 ==

== 사용법 ==

== 자동화 예시 ==`
  },
  {
    key: 'troubleshooting', title: '문제 해결', description: '증상, 원인, 해결 방법, 검증 절차로 시작합니다.', targetArea: 'any', category: '문제 해결',
    content: `{{문서 상태
|상태=검증 필요
}}

== 증상 ==

== 원인 ==

== 해결 방법 ==

== 검증 ==`
  }
];

try {
  console.log(`MineWiki seed (${args.dryRun ? 'dry-run' : 'write mode'})`);
  await seed();
  for (const change of changes) {
    console.log(change);
  }
  console.log(`seed complete changes=${changes.length}`);
} catch (error) {
  console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

async function seed() {
  await seedNamespaces();
  await seedRootSpacesAndPages();
  await seedCategoryAcl();
  await seedRolesAndPermissions();
  await seedSiteSettings();
  await seedDocumentTemplates();
  if (args.adminEmail) {
    await grantFirstAdmin(args.adminEmail);
  }
}

async function seedCategoryAcl() {
  const namespace = await prisma.wikiNamespace.findUnique({ where: { code: 'category' } });
  const rules = [
    ['create', 'allow', 'trusted', 10], ['create', 'deny', 'any', 100],
    ['edit', 'allow', 'trusted', 10], ['edit', 'deny', 'any', 100],
    ['move', 'allow', 'moderator', 10], ['move', 'deny', 'any', 100],
    ['delete', 'allow', 'moderator', 10], ['delete', 'deny', 'any', 100],
  ];
  if (!namespace) {
    if (!args.dryRun) throw new Error('Missing namespace category');
    for (const [action, effect, subjectValue] of rules) {
      changes.push(`would create category ACL ${action} ${effect} ${subjectValue}`);
    }
    return;
  }
  const reason = 'MineWiki category namespace default';
  for (const [action, effect, subjectValue, sortOrder] of rules) {
    const label = `category ACL ${action} ${effect} ${subjectValue}`;
    const existing = await prisma.aclRule.findFirst({
      where: {
        targetType: 'namespace',
        targetId: BigInt(namespace.id),
        action,
        effect,
        subjectType: 'perm',
        subjectValue,
        reason,
      },
    });
    if (args.dryRun) {
      changes.push(`${existing ? 'would update' : 'would create'} ${label}`);
      continue;
    }
    if (existing) {
      await prisma.aclRule.update({
        where: { id: existing.id },
        data: { sortOrder, expiresAt: null, updatedAt: now() },
      });
      changes.push(`updated ${label}`);
    } else {
      await prisma.aclRule.create({
        data: {
          targetType: 'namespace',
          targetId: BigInt(namespace.id),
          action,
          effect,
          subjectType: 'perm',
          subjectValue,
          sortOrder,
          reason,
          createdBy: null,
          createdAt: now(),
          updatedAt: now(),
        },
      });
      changes.push(`created ${label}`);
    }
  }
}

async function seedDocumentTemplates() {
  for (const template of documentTemplates) {
    const existing = await prisma.documentTemplate.findFirst({
      where: { spaceId: null, templateKey: template.key }
    });
    if (args.dryRun) {
      changes.push(`${existing ? 'would keep' : 'would create'} document template ${template.key}`);
      continue;
    }
    if (existing) {
      await prisma.documentTemplate.update({
        where: { id: existing.id },
        data: { status: 'active', updatedAt: now() }
      });
      changes.push(`kept document template ${template.key}`);
      continue;
    }
    await prisma.documentTemplate.create({
      data: {
        spaceId: null,
        templateKey: template.key,
        title: template.title,
        description: template.description,
        templateScope: 'global',
        targetArea: template.targetArea,
        defaultCategory: template.category,
        contentRaw: template.content,
        createdBy: null,
        status: 'active',
        createdAt: now(),
        updatedAt: now()
      }
    });
    changes.push(`created document template ${template.key}`);
  }
}

async function seedNamespaces() {
  for (const namespace of namespaces) {
    await write(`namespace ${namespace.code}`, () =>
      prisma.wikiNamespace.upsert({
        where: { code: namespace.code },
        update: {
          displayName: namespace.displayName,
          pathPrefix: namespace.pathPrefix,
          isContent: namespace.isContent,
        },
        create: namespace,
      }),
    );
  }
  await write('user wiki space', () => prisma.wikiSpace.upsert({
    where: { code: 'user' },
    update: {
      spaceKey: 'user', name: '사용자', title: '사용자', slug: 'user',
      spaceType: 'basic', rootNamespaceCode: 'user', rootPath: '/user',
      description: 'MineWiki 사용자 문서 공간', status: 'active', updatedAt: now(),
    },
    create: {
      code: 'user', spaceKey: 'user', name: '사용자', title: '사용자', slug: 'user',
      spaceType: 'basic', rootNamespaceCode: 'user', rootPath: '/user',
      description: 'MineWiki 사용자 문서 공간', status: 'active',
      createdAt: now(), updatedAt: now(),
    },
  }));
}

async function seedRootSpacesAndPages() {
  for (const spaceSpec of rootSpaces) {
    const namespace = await prisma.wikiNamespace.findUnique({
      where: { code: spaceSpec.rootNamespaceCode },
    });
    if (args.dryRun) {
      const space = await prisma.wikiSpace.findUnique({ where: { code: spaceSpec.code } });
      changes.push(`${space ? 'would update' : 'would create'} root space ${spaceSpec.code}`);
      const existing = namespace && space
        ? await prisma.wikiPage.findFirst({
            where: {
              OR: [
                { namespaceId: namespace.id, slug: slugifyTitle(spaceSpec.pageTitle) },
                { spaceId: space.id, localPath: slugifyTitle(spaceSpec.pageTitle) },
              ],
            },
          })
        : null;
      changes.push(existing ? `would keep existing page ${spaceSpec.pagePath}` : `would create page ${spaceSpec.pagePath}`);
      if (existing && space?.rootPageId === null) {
        changes.push(`would link root page ${spaceSpec.pagePath}`);
      }
      continue;
    }
    if (!namespace) {
      throw new Error(`Missing namespace ${spaceSpec.rootNamespaceCode}`);
    }

    const space = await prisma.wikiSpace.upsert({
      where: { code: spaceSpec.code },
      update: {
        spaceKey: spaceSpec.spaceKey,
        name: spaceSpec.name,
        title: spaceSpec.title,
        rootNamespaceCode: spaceSpec.rootNamespaceCode,
        rootPath: spaceSpec.rootPath,
        description: spaceSpec.description,
        status: 'active',
        updatedAt: now(),
      },
      create: {
        code: spaceSpec.code,
        spaceKey: spaceSpec.spaceKey,
        name: spaceSpec.name,
        title: spaceSpec.title,
        slug: null,
        spaceType: 'root',
        rootNamespaceCode: spaceSpec.rootNamespaceCode,
        rootPath: spaceSpec.rootPath,
        description: spaceSpec.description,
        status: 'active',
        createdAt: now(),
        updatedAt: now(),
      },
    });
    changes.push(`upserted root space ${spaceSpec.code}`);

    const slug = slugifyTitle(spaceSpec.pageTitle);
    const existing = await prisma.wikiPage.findFirst({
      where: {
        OR: [
          { namespaceId: namespace.id, slug },
          { spaceId: space.id, localPath: slug },
        ],
      },
    });
    if (existing) {
      changes.push(`kept existing page ${spaceSpec.pagePath}`);
      if (space.rootPageId === null) {
        await prisma.wikiSpace.update({
          where: { id: space.id },
          data: { rootPageId: existing.id, updatedAt: now() },
        });
        changes.push(`linked root page ${spaceSpec.pagePath}`);
      }
      continue;
    }
    await createSeedPage({
      namespaceId: namespace.id,
      namespaceCode: namespace.code,
      spaceId: space.id,
      title: spaceSpec.pageTitle,
      slug,
      displayTitle: spaceSpec.pageTitle,
      contentRaw: spaceSpec.content,
    });
    changes.push(`created page ${spaceSpec.pagePath}`);
  }
}

async function createSeedPage(input) {
  await prisma.$transaction(async (tx) => {
    const createdAt = now();
    const page = await tx.wikiPage.create({
      data: {
        namespaceId: input.namespaceId,
        spaceId: input.spaceId,
        localPath: input.slug,
        slug: input.slug,
        title: input.title,
        displayTitle: input.displayTitle,
        pageType: 'article',
        protectionLevel: 'open',
        status: 'normal',
        createdAt,
        updatedAt: createdAt,
      },
    });
    const revision = await tx.wikiPageRevision.create({
      data: {
        pageId: page.id,
        revisionNo: 1,
        parentRevisionId: null,
        contentRaw: input.contentRaw,
        contentAst: null,
        contentHash: hashContent(input.contentRaw),
        contentSize: Buffer.byteLength(input.contentRaw, 'utf8'),
        syntaxVersion: 'bwm-0.3',
        editSummary: 'first-run seed',
        isMinor: false,
        actorType: 'system',
        createdAt,
        visibility: 'public',
      },
    });
    await tx.wikiPage.update({
      where: { id: page.id },
      data: { currentRevisionId: revision.id, updatedAt: createdAt },
    });
    await tx.wikiSpace.updateMany({
      where: { id: input.spaceId, rootPageId: null },
      data: { rootPageId: page.id, updatedAt: createdAt },
    });
    await tx.wikiRecentChange.create({
      data: {
        pageId: page.id,
        revisionId: revision.id,
        actorId: null,
        changeType: 'create',
        title: page.title,
        namespaceCode: input.namespaceCode,
        summary: 'first-run seed',
        isMinor: false,
        createdAt,
      },
    });
  });
}

async function seedRolesAndPermissions() {
  for (const [code, displayName, description] of roles) {
    await write(`role ${code}`, () =>
      prisma.globalRole.upsert({
        where: { code },
        update: { displayName, description },
        create: { code, displayName, description },
      }),
    );
  }
  for (const [code, description] of permissions) {
    await write(`permission ${code}`, () =>
      prisma.permission.upsert({
        where: { code },
        update: { description },
        create: { code, description },
      }),
    );
  }
  if (args.dryRun) {
    for (const [roleCode, permissionCodes] of Object.entries(rolePermissions)) {
      for (const permissionCode of permissionCodes) {
        changes.push(`would upsert role permission ${roleCode}:${permissionCode}`);
      }
    }
    return;
  }
  const roleRows = await prisma.globalRole.findMany();
  const permissionRows = await prisma.permission.findMany();
  const roleByCode = new Map(roleRows.map((role) => [role.code, role]));
  const permissionByCode = new Map(permissionRows.map((permission) => [permission.code, permission]));
  for (const [roleCode, permissionCodes] of Object.entries(rolePermissions)) {
    const role = roleByCode.get(roleCode);
    if (!role) {
      throw new Error(`Missing role ${roleCode}`);
    }
    for (const permissionCode of permissionCodes) {
      const permission = permissionByCode.get(permissionCode);
      if (!permission) {
        throw new Error(`Missing permission ${permissionCode}`);
      }
      await write(`role permission ${roleCode}:${permissionCode}`, () =>
        prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: {
            roleId: role.id,
            permissionId: permission.id,
          },
        }),
      );
    }
  }
}

async function seedSiteSettings() {
  for (const [key, value, description] of siteSettings) {
    await write(`site setting ${key}`, () =>
      prisma.siteSetting.upsert({
        where: { key },
        update: { description },
        create: { key, value, description },
      }),
    );
  }
}

async function grantFirstAdmin(email) {
  const account = await prisma.account.findFirst({ where: { email } });
  if (!account) {
    changes.push(`admin skipped: account ${email} not found`);
    return;
  }
  const ownerRole = await prisma.globalRole.findUnique({ where: { code: 'owner' } });
  if (!ownerRole) {
    throw new Error('Missing owner role');
  }
  await write(`first admin ${email}`, () =>
    prisma.accountRole.upsert({
      where: {
        accountId_roleId: {
          accountId: account.id,
          roleId: ownerRole.id,
        },
      },
      update: {},
      create: {
        accountId: account.id,
        roleId: ownerRole.id,
      },
    }),
  );
}

async function write(label, operation) {
  if (args.dryRun) {
    changes.push(`would upsert ${label}`);
    return null;
  }
  const result = await operation();
  changes.push(`upserted ${label}`);
  return result;
}

function hashContent(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slugifyTitle(value) {
  return value.trim().replace(/\s+/g, '_') || '대문';
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    help: false,
    adminEmail: process.env.SEED_ADMIN_EMAIL?.trim() || '',
  };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg.startsWith('--admin-email=')) {
      parsed.adminEmail = arg.slice('--admin-email='.length).trim();
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm seed [--dry-run] [--admin-email=user@example.com]

Idempotently seeds:
  - wiki namespaces
  - root wiki spaces
  - /wiki/대문, /help/대문, /project/대문
  - default roles and permissions
  - default site settings
  - default document templates

Existing pages are never overwritten. Use --admin-email after creating the first account to grant the owner role.`);
}
