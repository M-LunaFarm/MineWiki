import { spawn } from 'node:child_process';
import { extname } from 'node:path';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DURATION_SECONDS = 300;
const DEFAULT_MAX_DIMENSION = 1920;
const DEFAULT_MAX_PIXELS = 1920 * 1080;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

const VIDEO_FORMATS = new Map([
  ['video/mp4', { extension: '.mp4', videoCodecs: new Set(['h264']), audioCodecs: new Set(['aac']) }],
  ['video/webm', { extension: '.webm', videoCodecs: new Set(['vp8', 'vp9', 'av1']), audioCodecs: new Set(['opus', 'vorbis']) }],
]);

export interface VideoValidationOptions {
  readonly maxBytes?: number;
  readonly maxDurationSeconds?: number;
  readonly maxDimension?: number;
  readonly maxPixels?: number;
  /** Test seam; production always uses the bounded ffprobe implementation. */
  readonly probe?: VideoProbe;
}

export interface ValidatedVideo {
  readonly buffer: Buffer;
  readonly mimeType: 'video/mp4' | 'video/webm';
  readonly extension: '.mp4' | '.webm';
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly originalSize: number;
}

export interface VideoProbeResult {
  readonly streams: ReadonlyArray<{
    readonly codecType: string;
    readonly codecName: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationSeconds?: number;
  }>;
  readonly durationSeconds?: number;
}

export type VideoProbe = (buffer: Buffer) => Promise<VideoProbeResult>;

export class VideoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoValidationError';
  }
}

export async function validateVideoUpload(
  buffer: Buffer,
  originalName: string,
  options: VideoValidationOptions = {},
): Promise<ValidatedVideo> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!buffer?.length) throw new VideoValidationError('업로드된 동영상이 비어 있습니다.');
  if (buffer.length > maxBytes) throw new VideoValidationError('동영상 용량은 20MiB를 초과할 수 없습니다.');

  const detected = await detectVideoType(buffer);
  const format = detected ? VIDEO_FORMATS.get(detected.mime) : undefined;
  if (!detected || !format) {
    throw new VideoValidationError('지원되지 않는 동영상 형식입니다. (MP4 H.264, WebM만 허용)');
  }
  const providedExtension = extname(originalName).toLowerCase();
  if (providedExtension && providedExtension !== format.extension) {
    throw new VideoValidationError('파일 확장자와 실제 동영상 형식이 일치하지 않습니다.');
  }

  let probe: VideoProbeResult;
  try {
    probe = await (options.probe ?? probeVideoWithFfprobe)(buffer);
  } catch (error) {
    if (error instanceof VideoValidationError) throw error;
    throw new VideoValidationError('동영상 메타데이터를 안전하게 확인할 수 없습니다.');
  }
  const videoStreams = probe.streams.filter((stream) => stream.codecType === 'video');
  const audioStreams = probe.streams.filter((stream) => stream.codecType === 'audio');
  if (
    videoStreams.length !== 1
    || audioStreams.length > 1
    || probe.streams.some((stream) => stream.codecType !== 'video' && stream.codecType !== 'audio')
  ) {
    throw new VideoValidationError('동영상은 비디오 1개와 선택적 오디오 1개 트랙만 포함할 수 있습니다.');
  }
  const video = videoStreams[0]!;
  if (!format.videoCodecs.has(video.codecName)) {
    throw new VideoValidationError('브라우저 재생이 보장되는 동영상 코덱이 아닙니다.');
  }
  if (audioStreams.some((stream) => !format.audioCodecs.has(stream.codecName))) {
    throw new VideoValidationError('브라우저 재생이 보장되는 오디오 코덱이 아닙니다.');
  }

  const width = Number(video.width);
  const height = Number(video.height);
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new VideoValidationError('동영상 해상도를 확인할 수 없습니다.');
  }
  if (width > maxDimension || height > maxDimension || width * height > maxPixels) {
    throw new VideoValidationError('동영상 해상도는 1080p 범위를 초과할 수 없습니다.');
  }
  const durationSeconds = Number(video.durationSeconds ?? probe.durationSeconds);
  const maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxDurationSeconds) {
    throw new VideoValidationError(`동영상 길이는 ${maxDurationSeconds}초 이하여야 합니다.`);
  }

  return {
    buffer,
    mimeType: detected.mime as ValidatedVideo['mimeType'],
    extension: format.extension as ValidatedVideo['extension'],
    width,
    height,
    durationSeconds,
    originalSize: buffer.length,
  };
}

async function detectVideoType(buffer: Buffer) {
  const { fileTypeFromBuffer } = await import('file-type');
  return fileTypeFromBuffer(buffer);
}

async function probeVideoWithFfprobe(buffer: Buffer): Promise<VideoProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,duration:format=duration',
      '-of', 'json',
      'pipe:0',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: VideoProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new VideoValidationError('동영상 검사 시간이 초과되었습니다.'));
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => finish(new VideoValidationError('동영상 검사기를 실행할 수 없습니다.')));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new VideoValidationError('동영상 메타데이터가 허용 범위를 초과했습니다.'));
      } else {
        output.push(chunk);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new VideoValidationError('손상되었거나 지원되지 않는 동영상입니다.'));
      try {
        const parsed = JSON.parse(Buffer.concat(output).toString('utf8')) as {
          streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>;
          format?: { duration?: string };
        };
        finish(undefined, {
          streams: (parsed.streams ?? []).map((stream) => ({
            codecType: stream.codec_type ?? '',
            codecName: stream.codec_name ?? '',
            width: stream.width,
            height: stream.height,
            durationSeconds: finiteNumber(stream.duration),
          })),
          durationSeconds: finiteNumber(parsed.format?.duration),
        });
      } catch {
        finish(new VideoValidationError('동영상 검사 결과가 올바르지 않습니다.'));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(buffer);
  });
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
