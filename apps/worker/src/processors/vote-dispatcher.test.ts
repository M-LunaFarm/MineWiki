import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { createVoteDispatcher, type VoteDispatchExecutionJob } from './vote-dispatcher';

test('dispatch prefers Votifier v2 when available', async () => {
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const payload = chunk.toString('utf8').trim();
      const data = JSON.parse(payload) as {
        method: string;
        token: string;
        username: string;
      };
      assert.equal(data.method, 'token');
      assert.equal(data.token, 'token-123');
      assert.equal(data.username, 'DemoPlayer');
      socket.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Unexpected server address');
  }

  const dispatcher = createVoteDispatcher();
  const job: VoteDispatchExecutionJob = {
    voteId: '6ebd0b54-5864-46c2-a835-942937b0f6ec',
    serverId: '8d5d43eb-5e53-4ce9-90a0-dfd8fbfa9b6b',
    username: 'DemoPlayer',
    ipAddress: '192.0.2.10',
    votedAt: new Date().toISOString(),
    targets: [
      {
        targetId: 'f8be13d6-b155-44c9-ad90-2f7efa96b7d7',
        dispatchAttemptId: '6396003e-0956-4a2e-bf2b-a2ad83d7102f',
        protocol: 'v2',
        host: '127.0.0.1',
        port: address.port,
        token: 'token-123'
      }
    ]
  };

  const result = await dispatcher.dispatch(job);
  assert.deepEqual(result, {
    success: true,
    protocol: 'v2',
    dispatchAttemptId: '6396003e-0956-4a2e-bf2b-a2ad83d7102f'
  });
  server.close();
});

test('dispatch falls back to v1 when v2 fails', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });

  const v1Server = createServer((socket: Socket) => {
    socket.write('VOTIFIER 1 12345678901234567890\n');
    socket.once('data', (chunk) => {
      const decrypted = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
        chunk
      )
        .toString('utf8')
        .replace(/\0+$/, '');
      const lines = decrypted.trim().split('\n');
      assert.equal(lines[0], 'VOTE');
      assert.equal(lines[2], 'FallbackUser');
      socket.end();
    });
  });
  v1Server.listen(0, '127.0.0.1');
  await once(v1Server, 'listening');
  const v1Address = v1Server.address();
  if (v1Address === null || typeof v1Address === 'string') {
    throw new Error('Unexpected server address');
  }

  const dispatcher = createVoteDispatcher();
  const job: VoteDispatchExecutionJob = {
    voteId: '6f59484d-fb35-4a3d-b269-3d7a8d17f612',
    serverId: '22fe3ae4-685b-4bb0-9d30-35bbf83de4a3',
    username: 'FallbackUser',
    votedAt: new Date().toISOString(),
    targets: [
      {
        targetId: '62aa8c97-dad8-4095-955a-31f082c375a6',
        dispatchAttemptId: 'd9b3174a-c0fa-4eed-92fb-cef21d45c8e0',
        protocol: 'v2',
        host: '127.0.0.1',
        port: 65500,
        token: 'invalid-token'
      },
      {
        targetId: '9798a301-893e-42d6-97f2-14b701104dbf',
        dispatchAttemptId: 'b1c0c1c7-4118-4d2b-87f6-fc63c6f36df3',
        protocol: 'v1',
        host: '127.0.0.1',
        port: v1Address.port,
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString()
      }
    ]
  };

  const result = await dispatcher.dispatch(job);
  assert.deepEqual(result, {
    success: true,
    protocol: 'v1',
    dispatchAttemptId: 'b1c0c1c7-4118-4d2b-87f6-fc63c6f36df3'
  });
  v1Server.close();
});

test('retryable failure is recorded', async () => {
  const events: Array<{ type: string; id: string; error?: unknown }> = [];
  const dispatcher = createVoteDispatcher({
    recorder: {
      async markStarted(dispatchAttemptId) {
        events.push({ type: 'started', id: dispatchAttemptId });
      },
      async markSucceeded(dispatchAttemptId) {
        events.push({ type: 'succeeded', id: dispatchAttemptId });
      },
      async markFailed(dispatchAttemptId, error) {
        events.push({ type: 'failed', id: dispatchAttemptId, error });
      }
    }
  });
  const job: VoteDispatchExecutionJob = {
    voteId: '13232073-7a1a-4108-bd77-627ec0b91906',
    serverId: '29830a11-830b-4965-89dd-7438ba509a66',
    username: 'RetryUser',
    votedAt: new Date().toISOString(),
    targets: [
      {
        targetId: 'c3e0745a-488d-49c6-bffc-069b6b2e393e',
        dispatchAttemptId: 'c853d4f4-b322-4986-a47a-42e671af7070',
        protocol: 'v2',
        host: '127.0.0.1',
        port: 65500,
        token: 'token'
      }
    ]
  };

  await assert.rejects(() => dispatcher.dispatch(job));
  assert.equal(dispatcher.isRetryable(events.at(-1)?.error), true);
  assert.deepEqual(
    events.map((event) => [event.type, event.id]),
    [
      ['started', 'c853d4f4-b322-4986-a47a-42e671af7070'],
      ['failed', 'c853d4f4-b322-4986-a47a-42e671af7070']
    ]
  );
});

test('non-retryable failure is recorded', async () => {
  const events: Array<{ type: string; id: string; error?: unknown }> = [];
  const dispatcher = createVoteDispatcher({
    recorder: {
      async markStarted(dispatchAttemptId) {
        events.push({ type: 'started', id: dispatchAttemptId });
      },
      async markSucceeded(dispatchAttemptId) {
        events.push({ type: 'succeeded', id: dispatchAttemptId });
      },
      async markFailed(dispatchAttemptId, error) {
        events.push({ type: 'failed', id: dispatchAttemptId, error });
      }
    }
  });
  const job: VoteDispatchExecutionJob = {
    voteId: 'd7d2bbde-1409-48b8-ad35-fd27fd1e0b46',
    serverId: '80ad55fe-4552-4ca4-9a65-0432ce8e9e0e',
    username: 'BadConfig',
    votedAt: new Date().toISOString(),
    targets: [
      {
        targetId: 'c0c8e113-44f8-4881-8d85-ffdf92d40294',
        dispatchAttemptId: '84acf734-427c-47aa-bf3a-6464dc9478a5',
        protocol: 'v2',
        host: '127.0.0.1',
        port: 8192
      }
    ]
  };

  await assert.rejects(() => dispatcher.dispatch(job), /missing token/);
  assert.equal(dispatcher.isRetryable(events.at(-1)?.error), false);
  assert.deepEqual(
    events.map((event) => [event.type, event.id]),
    [
      ['started', '84acf734-427c-47aa-bf3a-6464dc9478a5'],
      ['failed', '84acf734-427c-47aa-bf3a-6464dc9478a5']
    ]
  );
});
