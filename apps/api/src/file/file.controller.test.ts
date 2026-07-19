import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyReply } from 'fastify';
import { FileController } from './file.controller';

function replyFixture() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  const reply = {
    header(name: string, value: string) { headers.set(name.toLowerCase(), value); return reply; },
    status(value: number) { statusCode = value; return reply; },
    redirect() { throw new Error('unexpected redirect'); },
  };
  return { reply: reply as unknown as FastifyReply, headers, statusCode: () => statusCode };
}

async function streamBody(streamable: { getStream(): NodeJS.ReadableStream } | undefined): Promise<Buffer> {
  assert.ok(streamable);
  const chunks: Buffer[] = [];
  for await (const chunk of streamable.getStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('video raw responses support bounded single byte ranges and nosniff', async () => {
  const controller = new FileController({
    async getRawFile() {
      return {
        buffer: Buffer.from('0123456789'),
        mimeType: 'video/mp4',
        filename: 'demo.mp4',
        cacheControl: 'private, no-store',
      };
    },
  } as never);
  const output = replyFixture();
  const result = await controller.getRawFile(
    'file-1',
    { headers: { range: 'bytes=2-5' }, sessionPayload: null } as never,
    output.reply,
  );

  assert.equal(output.statusCode(), 206);
  assert.equal(output.headers.get('accept-ranges'), 'bytes');
  assert.equal(output.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(output.headers.get('content-length'), '4');
  assert.equal(output.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await streamBody(result)).toString(), '2345');
});

test('invalid video ranges return 416 without leaking the body', async () => {
  const controller = new FileController({
    async getRawFile() {
      return {
        buffer: Buffer.from('0123456789'),
        mimeType: 'video/webm',
        filename: 'demo.webm',
        cacheControl: 'public, max-age=60',
      };
    },
  } as never);
  const output = replyFixture();
  const result = await controller.getRawFile(
    'file-1',
    { headers: { range: 'bytes=99-100' }, sessionPayload: null } as never,
    output.reply,
  );

  assert.equal(output.statusCode(), 416);
  assert.equal(output.headers.get('content-range'), 'bytes */10');
  assert.equal((await streamBody(result)).length, 0);
});
