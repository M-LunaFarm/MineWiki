import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { ServerController } from './server.controller';

test('ranking controller normalizes filters and pagination', async () => {
  const calls: unknown[] = [];
  const controller = new ServerController(
    {
      rankings: async (query: unknown) => {
        calls.push(query);
        return {
          items: [],
          total: 0,
          summary: { online: 0, verified: 0, votes24h: 0 },
          page: 2,
          pageSize: 12,
          totalPages: 0,
          rankUpdatedAt: null,
        };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await controller.rankings(
    'java',
    'Verified',
    ' survival ',
    ' ranked ',
    'latest',
    '2',
    '12',
  );

  assert.equal(result.page, 2);
  assert.deepEqual(calls, [
    {
      edition: 'java',
      grade: 'Verified',
      tag: 'survival',
      search: 'ranked',
      sort: 'latest',
      page: 2,
      pageSize: 12,
    },
  ]);
});

test('ranking controller rejects oversized page sizes and unknown sorts', () => {
  const controller = new ServerController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  assert.throws(
    () => controller.rankings(undefined, undefined, undefined, undefined, 'paid', '1', '500'),
    (error: unknown) => error instanceof ZodError,
  );
});
