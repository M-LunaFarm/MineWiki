const FILE_ALIGNMENTS = new Set(['normal', 'left', 'center', 'right']);
const FILE_OBJECT_FITS = new Set(['contain', 'cover', 'fill', 'scale-down']);

export function buildWikiFileMarkup({ filename, caption, width, align = 'normal', objectFit = 'contain', alt = '' }) {
  const numericWidth = Number(width);
  const cleanCaption = String(caption || '').trim() || filename;
  const safeAlign = FILE_ALIGNMENTS.has(align) ? align : 'normal';
  const safeObjectFit = FILE_OBJECT_FITS.has(objectFit) ? objectFit : 'contain';
  const optionPairs = [
    Number.isSafeInteger(numericWidth) && numericWidth >= 1 && numericWidth <= 4096 ? `width=${numericWidth}` : '',
    safeAlign !== 'normal' ? `align=${safeAlign}` : '',
    safeObjectFit !== 'contain' ? `object-fit=${safeObjectFit}` : '',
    String(alt).trim() ? `alt=${encodeURIComponent(String(alt).trim().slice(0, 256))}` : '',
    `caption=${encodeURIComponent(cleanCaption.slice(0, 256))}`
  ].filter(Boolean);
  return `[[파일:${filename}|섬네일|${optionPairs.join('&')}]]`;
}
