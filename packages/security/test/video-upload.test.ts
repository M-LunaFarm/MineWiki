import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVideoUpload, VideoValidationError, type VideoProbeResult } from '../src/video-upload';

const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('isomiso2'),
]);
const probe = async (overrides: Partial<VideoProbeResult> = {}): Promise<VideoProbeResult> => ({
  streams: [{ codecType: 'video', codecName: 'h264', width: 1280, height: 720, durationSeconds: 12 }],
  durationSeconds: 12,
  ...overrides,
});

test('accepts a bounded MP4 with one browser-safe video track', async () => {
  const result = await validateVideoUpload(mp4, 'demo.mp4', { probe });
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(result.extension, '.mp4');
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.durationSeconds, 12);
});

test('rejects forged extensions, oversized input and unsafe track layouts', async () => {
  await assert.rejects(validateVideoUpload(mp4, 'demo.webm', { probe }), VideoValidationError);
  await assert.rejects(validateVideoUpload(Buffer.alloc(20 * 1024 * 1024 + 1), 'huge.mp4', { probe }), /20MiB/u);
  await assert.rejects(validateVideoUpload(mp4, 'demo.mp4', {
    probe: () => probe({ streams: [
      { codecType: 'video', codecName: 'h264', width: 1280, height: 720 },
      { codecType: 'attachment', codecName: 'bin_data' },
    ] }),
  }), /트랙/u);
});

test('rejects unsupported codecs, excessive resolution and excessive duration', async () => {
  await assert.rejects(validateVideoUpload(mp4, 'demo.mp4', {
    probe: () => probe({ streams: [{ codecType: 'video', codecName: 'hevc', width: 1280, height: 720 }] }),
  }), /코덱/u);
  await assert.rejects(validateVideoUpload(mp4, 'demo.mp4', {
    probe: () => probe({ streams: [{ codecType: 'video', codecName: 'h264', width: 1920, height: 1920 }] }),
  }), /1080p/u);
  await assert.rejects(validateVideoUpload(mp4, 'demo.mp4', {
    probe: () => probe({
      streams: [{ codecType: 'video', codecName: 'h264', width: 1280, height: 720, durationSeconds: 301 }],
      durationSeconds: 301,
    }),
  }), /300초/u);
});
