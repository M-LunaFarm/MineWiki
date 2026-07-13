-- Give every existing server wiki a usable GitBook-style starter navigation.
-- Older editor builds could save child pages with only the relative local_path.
-- Preserve those pages and repair their space/path before inserting defaults.
UPDATE pages p
JOIN server_wikis sw ON p.slug IN (
  CONCAT(sw.slug, '/시작하기'),
  CONCAT(sw.slug, '/규칙'),
  CONCAT(sw.slug, '/FAQ')
)
SET p.space_id = sw.space_id,
    p.local_path = p.slug,
    p.display_title = CASE
      WHEN p.slug = CONCAT(sw.slug, '/시작하기') THEN '시작하기'
      WHEN p.slug = CONCAT(sw.slug, '/규칙') THEN '서버 규칙'
      ELSE '자주 묻는 질문'
    END,
    p.page_type = 'server',
    p.status = 'normal',
    p.updated_at = CURRENT_TIMESTAMP(3)
WHERE sw.status = 'active';

INSERT INTO pages (
  namespace_id, space_id, local_path, slug, title, display_title,
  page_type, protection_level, status, created_by, created_at, updated_at
)
SELECT
  ns.id,
  sw.space_id,
  CONCAT(sw.slug, '/', starter.path),
  CONCAT(sw.slug, '/', starter.path),
  CONCAT(sw.slug, '/', starter.path),
  starter.display_title,
  'server',
  'open',
  'normal',
  sw.created_by,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM server_wikis sw
JOIN namespaces ns ON ns.code = 'server'
JOIN (
  SELECT '시작하기' AS path, '시작하기' AS display_title
  UNION ALL SELECT '규칙', '서버 규칙'
  UNION ALL SELECT 'FAQ', '자주 묻는 질문'
) starter
WHERE sw.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM pages existing
    WHERE existing.namespace_id = ns.id
      AND existing.slug = CONCAT(sw.slug, '/', starter.path)
  );

INSERT INTO page_revisions (
  page_id, revision_no, parent_revision_id, content_raw, content_ast,
  content_hash, content_size, syntax_version, edit_summary, is_minor,
  created_by, actor_type, actor_user_id, created_at, visibility
)
SELECT
  p.id,
  1,
  NULL,
  CASE
    WHEN p.local_path = CONCAT(sw.slug, '/시작하기') THEN CONCAT(
      '== ', sw.server_name, ' 시작하기 ==\n\n',
      '* 접속 주소: ', COALESCE(sw.host, '정보 없음'), ':', COALESCE(sw.port, 25565), '\n',
      '* Minecraft 멀티플레이에서 서버 추가를 선택하세요.\n',
      '* 접속 전 [[규칙]]을 확인해 주세요.\n\n',
      '문제가 있다면 [[FAQ]]를 확인해 주세요.\n'
    )
    WHEN p.local_path = CONCAT(sw.slug, '/규칙') THEN CONCAT(
      '== 기본 규칙 ==\n\n',
      '이 문서는 ', sw.server_name, ' 운영자가 실제 서버 규칙으로 편집할 수 있습니다.\n\n',
      '* 다른 이용자를 존중해 주세요.\n',
      '* 서버 운영 정책과 공지를 확인해 주세요.\n',
      '* 제재 문의는 MineWiki 고객센터를 이용해 주세요.\n'
    )
    ELSE CONCAT(
      '== 자주 묻는 질문 ==\n\n',
      '=== 서버 주소는 무엇인가요? ===\n', COALESCE(sw.host, '정보 없음'), ':', COALESCE(sw.port, 25565), '\n\n',
      '=== 처음 접속하려면 어떻게 하나요? ===\n[[시작하기]] 문서를 확인해 주세요.\n'
    )
  END AS content_raw,
  NULL,
  SHA2(CASE
    WHEN p.local_path = CONCAT(sw.slug, '/시작하기') THEN CONCAT('starter:', sw.slug, ':start')
    WHEN p.local_path = CONCAT(sw.slug, '/규칙') THEN CONCAT('starter:', sw.slug, ':rules')
    ELSE CONCAT('starter:', sw.slug, ':faq')
  END, 256),
  OCTET_LENGTH(CASE
    WHEN p.local_path = CONCAT(sw.slug, '/시작하기') THEN CONCAT('== ', sw.server_name, ' 시작하기 ==')
    WHEN p.local_path = CONCAT(sw.slug, '/규칙') THEN '== 기본 규칙 =='
    ELSE '== 자주 묻는 질문 =='
  END),
  'bwm-0.3',
  '서버 위키 기본 문서 생성',
  FALSE,
  sw.created_by,
  'user',
  sw.created_by,
  CURRENT_TIMESTAMP(3),
  'public'
FROM pages p
JOIN server_wikis sw ON sw.space_id = p.space_id
WHERE p.current_revision_id IS NULL
  AND p.local_path IN (
    CONCAT(sw.slug, '/시작하기'),
    CONCAT(sw.slug, '/규칙'),
    CONCAT(sw.slug, '/FAQ')
  );

UPDATE page_revisions revision
JOIN pages p ON p.id = revision.page_id
JOIN server_wikis sw ON sw.space_id = p.space_id
SET revision.content_hash = SHA2(revision.content_raw, 256),
    revision.content_size = OCTET_LENGTH(revision.content_raw)
WHERE revision.revision_no = 1
  AND revision.edit_summary = '서버 위키 기본 문서 생성';

UPDATE pages p
JOIN server_wikis sw ON sw.space_id = p.space_id
JOIN page_revisions revision ON revision.page_id = p.id AND revision.revision_no = 1
SET p.current_revision_id = revision.id,
    p.updated_at = CURRENT_TIMESTAMP(3)
WHERE p.current_revision_id IS NULL
  AND p.local_path IN (
    CONCAT(sw.slug, '/시작하기'),
    CONCAT(sw.slug, '/규칙'),
    CONCAT(sw.slug, '/FAQ')
  );
