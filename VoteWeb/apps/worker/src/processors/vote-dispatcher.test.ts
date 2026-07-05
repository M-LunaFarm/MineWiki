import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { createVoteDispatcher } from './vote-dispatcher';
import type { VoteDispatchJob } from '@creepervote/schemas';

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
  const job: VoteDispatchJob = {
    serverId: '8d5d43eb-5e53-4ce9-90a0-dfd8fbfa9b6b',
    username: 'DemoPlayer',
    ipAddress: '192.0.2.10',
    votedAt: new Date().toISOString(),
    targets: [
      {
        protocol: 'v2',
        host: '127.0.0.1',
        port: address.port,
        token: 'token-123'
      }
    ]
  };

  const result = await dispatcher.dispatch(job);
  assert.deepEqual(result, { success: true, protocol: 'v2' });
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
  const job: VoteDispatchJob = {
    serverId: '22fe3ae4-685b-4bb0-9d30-35bbf83de4a3',
    username: 'FallbackUser',
    votedAt: new Date().toISOString(),
    targets: [
      {
        protocol: 'v2',
        host: '127.0.0.1',
        port: 65500,
        token: 'invalid-token'
      },
      {
        protocol: 'v1',
        host: '127.0.0.1',
        port: v1Address.port,
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString()
      }
    ]
  };

  const result = await dispatcher.dispatch(job);
  assert.deepEqual(result, { success: true, protocol: 'v1' });
  v1Server.close();
});
