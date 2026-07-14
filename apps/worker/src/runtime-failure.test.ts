import assert from 'node:assert/strict';
import test from 'node:test';
import { terminateOnRunLoopFailure } from './runtime-failure';

test('fatal run-loop failure closes resources once and exits non-zero', async () => {
  let shuttingDown = false;
  let closes = 0;
  const exits: number[] = [];
  const failures: string[] = [];
  const options = {
    error: new Error('consumer stopped'),
    workerName: 'votes',
    isShuttingDown: () => shuttingDown,
    markShuttingDown: () => { shuttingDown = true; },
    closeResources: async () => { closes += 1; },
    logFailure: (_error: unknown, workerName: string) => { failures.push(workerName); },
    exit: (code: number) => { exits.push(code); },
  };

  await Promise.all([
    terminateOnRunLoopFailure(options),
    terminateOnRunLoopFailure({ ...options, workerName: 'rankings' }),
  ]);

  assert.equal(closes, 1);
  assert.deepEqual(failures, ['votes']);
  assert.deepEqual(exits, [1]);
});

test('fatal run-loop failure still exits when cleanup throws', async () => {
  let shuttingDown = false;
  const exits: number[] = [];
  await assert.rejects(
    terminateOnRunLoopFailure({
      error: new Error('consumer stopped'),
      workerName: 'votes',
      isShuttingDown: () => shuttingDown,
      markShuttingDown: () => { shuttingDown = true; },
      closeResources: async () => { throw new Error('cleanup failed'); },
      logFailure: () => undefined,
      exit: (code) => { exits.push(code); },
    }),
    /cleanup failed/,
  );
  assert.deepEqual(exits, [1]);
});
