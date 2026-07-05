const net = require('net');
const config = require('./config');
const { query } = require('./db');
const { hmacSha256Hex, randomId } = require('./utils');

const MAX_RETRIES = Number(process.env.PUSH_MAX_RETRIES || 5);
const BASE_DELAY_SECONDS = Number(process.env.PUSH_RETRY_BASE_SECONDS || 30);
const BATCH_LIMIT = Number(process.env.PUSH_BATCH_LIMIT || 25);

function computeNextRetry(attempt) {
  const delay = BASE_DELAY_SECONDS * Math.pow(2, Math.max(0, attempt - 1));
  return delay;
}

async function fetchDeliveries() {
  return query(
    `SELECT d.delivery_id, d.event_id, d.guild_id, d.server_id, d.attempt_count, d.payload_json,
            s.server_host, s.server_port, s.server_secret
     FROM push_deliveries d
     JOIN guild_servers s ON s.server_id = d.server_id
     WHERE d.status IN ('pending', 'failed')
       AND (d.next_retry_at IS NULL OR d.next_retry_at <= NOW())
       AND d.attempt_count < ?
     ORDER BY d.updated_at ASC
     LIMIT ?`,
    [MAX_RETRIES, BATCH_LIMIT]
  );
}

async function updateSuccess(deliveryId, status, latencyMs) {
  await query(
    `UPDATE push_deliveries
     SET status = 'success', attempt_count = attempt_count + 1, last_http_status = ?, last_latency_ms = ?, updated_at = NOW(), next_retry_at = NULL
     WHERE delivery_id = ?`,
    [status, latencyMs, deliveryId]
  );
}

async function updateFailure(deliveryId, status, errorMessage, nextRetrySeconds) {
  await query(
    `UPDATE push_deliveries
     SET status = 'failed', attempt_count = attempt_count + 1, last_http_status = ?, last_error = ?,
         updated_at = NOW(), next_retry_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE delivery_id = ?`,
    [status || null, errorMessage || null, nextRetrySeconds, deliveryId]
  );
}

async function sendDelivery(delivery) {
  let payload;
  try {
    payload = JSON.parse(delivery.payload_json || '{}');
  } catch (err) {
    await updateFailure(delivery.delivery_id, null, 'invalid_payload_json', computeNextRetry(delivery.attempt_count + 1));
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomId();
  const body = JSON.stringify({ timestamp, nonce, payload });
  const signature = hmacSha256Hex(delivery.server_secret, body);
  const packet = JSON.stringify({ timestamp, nonce, signature, payload }) + '\n';

  const startedAt = Date.now();
  try {
    const response = await sendTcpPayload(delivery, packet, config.pushTimeoutMs);
    const latencyMs = Date.now() - startedAt;
    if (response === 'ok') {
      await updateSuccess(delivery.delivery_id, 200, latencyMs);
      await query('UPDATE guild_servers SET last_seen_at = NOW() WHERE server_id = ?', [delivery.server_id]);
    } else {
      await updateFailure(
        delivery.delivery_id,
        null,
        response || 'tcp_error',
        computeNextRetry(delivery.attempt_count + 1)
      );
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    await updateFailure(
      delivery.delivery_id,
      null,
      err.message,
      computeNextRetry(delivery.attempt_count + 1)
    );
    await query('UPDATE push_deliveries SET last_latency_ms = ? WHERE delivery_id = ?', [latencyMs, delivery.delivery_id]);
  }
}

function sendTcpPayload(delivery, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = delivery.server_host;
    const port = Number.parseInt(delivery.server_port, 10);
    if (!host || Number.isNaN(port)) {
      reject(new Error('missing_server_address'));
      return;
    }

    const socket = new net.Socket();
    let settled = false;
    const finish = (err, status) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (err) {
        reject(err);
        return;
      }
      resolve(status || 'ok');
    };

    socket.setTimeout(timeoutMs || 5000);
    socket.on('timeout', () => finish(new Error('timeout')));
    socket.on('error', (err) => finish(err));
    socket.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) {
        return;
      }
      if (text.toLowerCase() === 'ok') {
        finish(null, 'ok');
        return;
      }
      finish(null, text);
    });
    socket.on('close', (hadError) => {
      if (!hadError) {
        finish(null, 'ok');
      }
    });

    socket.connect(port, host, () => {
      socket.write(payload, (err) => {
        if (err) {
          finish(err);
          return;
        }
        socket.end();
      });
    });
  });
}

async function runOnce() {
  const deliveries = await fetchDeliveries();
  if (deliveries.length === 0) {
    return;
  }

  for (const delivery of deliveries) {
    await sendDelivery(delivery);
  }
}

async function loop() {
  while (true) {
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

loop().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed:', err.message);
  process.exit(1);
});
