const crypto = require('crypto');

function toKstIso(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace('Z', '+09:00');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmacSha256Hex(secret, input) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

function randomId() {
  return crypto.randomUUID();
}

module.exports = {
  toKstIso,
  sha256Hex,
  hmacSha256Hex,
  randomId
};
