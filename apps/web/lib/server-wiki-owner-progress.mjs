export function serverWikiOwnerProgress(readiness, serverId) {
  if (!readiness || !serverId) return null;
  if (readiness.status === 'unlinked') {
    return {
      tone: 'start',
      eyebrow: 'Server Documentation',
      title: '서버 위키를 시작하세요',
      description: '서버 소개와 접속 정보를 바탕으로 대문·시작하기·규칙·FAQ 초안을 만들 수 있습니다.',
      href: '#server-wiki-management',
      action: '서버 위키 만들기',
    };
  }
  if (readiness.status === 'repair_required') {
    return {
      tone: 'danger',
      eyebrow: 'Server Documentation',
      title: '서버 위키 연결 복구가 필요합니다',
      description: '기존 문서는 보존되어 있습니다. 지원 요청을 보내 연결 상태를 안전하게 복구하세요.',
      href: `/support/new?category=server_claim&serverId=${encodeURIComponent(serverId)}`,
      action: '복구 요청하기',
    };
  }
  if (readiness.status === 'needs_attention') {
    return {
      tone: 'attention',
      eyebrow: 'Draft Documentation',
      title: '서버 위키 초안을 계속 완성하세요',
      description: `${readiness.completedChecks}/${readiness.totalChecks}개 공개 준비 항목을 완료했습니다. 다음 한 단계부터 이어서 작성할 수 있습니다.`,
      href: readiness.nextAction?.href ?? readiness.wikiUrl ?? '#server-wiki-management',
      action: readiness.nextAction?.label ?? '초안 계속 작성',
    };
  }
  return {
    tone: 'ready',
    eyebrow: 'Ready to Publish',
    title: '서버 위키 공개 준비가 완료되었습니다',
    description: '문서와 검색 색인이 준비되었습니다. 공개 후보를 확인하고 독립 문서 공간을 게시하세요.',
    href: `/servers/${encodeURIComponent(serverId)}/wiki-layouts`,
    action: '공개 설정 열기',
  };
}
