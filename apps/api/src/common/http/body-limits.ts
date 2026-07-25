export const MAX_IMAGE_UPLOAD_BYTES = 2 * 1024 * 1024;

// Image uploads arrive as a data URL inside JSON. Base64 expands the binary by
// roughly 4/3, so the parser must accept more than the validated 2 MiB image.
export const API_JSON_BODY_LIMIT_BYTES = 3 * 1024 * 1024;
