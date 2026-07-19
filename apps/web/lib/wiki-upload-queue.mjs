export const MAX_WIKI_UPLOAD_FILES = 10;
export const MAX_WIKI_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024;

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']);

export function wikiUploadFileKey(file) {
  return [
    String(file.name ?? '').normalize('NFC'),
    Number(file.size ?? 0),
    Number(file.lastModified ?? 0),
    String(file.type ?? '').toLowerCase(),
  ].join('\u0000');
}

export function mergeWikiUploadSelection(existing, selected) {
  const items = [...existing];
  const known = new Set(items.map((item) => item.id));
  const rejected = [];
  let totalBytes = items.reduce((sum, item) => sum + Number(item.file.size ?? 0), 0);

  for (const file of selected) {
    const id = wikiUploadFileKey(file);
    if (known.has(id)) {
      rejected.push(`${file.name}: 이미 대기열에 있습니다.`);
      continue;
    }
    if (!ALLOWED_MEDIA_TYPES.has(String(file.type ?? '').toLowerCase())) {
      rejected.push(`${file.name}: PNG, JPEG, WebP, MP4, WebM 파일만 선택할 수 있습니다.`);
      continue;
    }
    if (items.length >= MAX_WIKI_UPLOAD_FILES) {
      rejected.push(`${file.name}: 한 번에 최대 ${MAX_WIKI_UPLOAD_FILES}개까지 선택할 수 있습니다.`);
      continue;
    }
    if (totalBytes + Number(file.size ?? 0) > MAX_WIKI_UPLOAD_TOTAL_BYTES) {
      rejected.push(`${file.name}: 선택한 파일의 합계는 20MiB 이하여야 합니다.`);
      continue;
    }
    known.add(id);
    totalBytes += Number(file.size ?? 0);
    items.push({ id, file, status: 'queued', result: null, error: null });
  }

  return { items, rejected, totalBytes };
}

export function wikiUploadMetadataError({ queuedCount, license, sourceUrl }) {
  if (queuedCount < 1 || !String(license ?? '').trim()) {
    return '대기 중인 파일과 라이선스를 모두 선택해 주세요.';
  }
  if (license !== 'self-created' && !String(sourceUrl ?? '').trim()) {
    return '직접 제작하지 않은 파일은 원본 출처 URL이 필요합니다.';
  }
  return null;
}

export async function runWikiUploadQueue(items, upload, onTransition, shouldContinue = () => true) {
  let completed = 0;
  for (const item of items) {
    if (item.status !== 'queued') continue;
    if (!shouldContinue()) return { completed, stopped: true };
    onTransition(item.id, { status: 'uploading', result: null, error: null });
    try {
      const result = await upload(item);
      onTransition(item.id, { status: 'success', result, error: null });
    } catch (error) {
      onTransition(item.id, {
        status: 'failed',
        result: null,
        error: error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.',
      });
    }
    completed += 1;
  }
  return { completed, stopped: false };
}

export function successfulWikiUploadMarkup(items) {
  return items
    .filter((item) => item.status === 'success' && item.result?.filename)
    .map((item) => `[[파일:${item.result.filename}]]`)
    .join('\n');
}
