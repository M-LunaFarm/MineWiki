import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export type AddressFamily = 4 | 6;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: AddressFamily;
}

export interface OutboundTarget {
  readonly host: string;
  readonly port: number;
  readonly addresses: readonly ResolvedAddress[];
}

export interface OutboundValidationOptions {
  readonly label?: string;
  readonly allowIpv6?: boolean;
  readonly allowedPorts?: readonly number[];
  readonly lookup?: LookupFunction;
}

type LookupFunction = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true }
) => Promise<Array<{ readonly address: string; readonly family: number }>>;

type UnsafeReason =
  | 'invalid_host'
  | 'invalid_port'
  | 'ipv6_not_allowed'
  | 'private_address'
  | 'resolve_failed';

export class UnsafeEndpointError extends Error {
  readonly reason: UnsafeReason;

  constructor(reason: UnsafeReason, message: string) {
    super(message);
    this.name = 'UnsafeEndpointError';
    this.reason = reason;
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost']);

const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32'
];

const IPV4_CIDR_REGEX = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;

function ensureValidHost(host: string, label: string): string {
  const trimmed = host.trim();
  if (trimmed.length === 0) {
    throw new UnsafeEndpointError('invalid_host', `${label}: host is required`);
  }
  if (BLOCKED_HOSTNAMES.has(trimmed.toLowerCase())) {
    throw new UnsafeEndpointError('invalid_host', `${label}: localhost is not allowed`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new UnsafeEndpointError('invalid_host', `${label}: host must not include path separators`);
  }
  if (trimmed.includes('@')) {
    throw new UnsafeEndpointError('invalid_host', `${label}: host must not include credentials`);
  }
  return trimmed;
}

function ensureValidPort(port: number, label: string, allowed?: readonly number[]): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnsafeEndpointError('invalid_port', `${label}: port must be between 1 and 65535`);
  }
  if (allowed && allowed.length > 0 && !allowed.includes(port)) {
    throw new UnsafeEndpointError(
      'invalid_port',
      `${label}: port ${port} is not in the allowlist (${allowed.join(', ')})`
    );
  }
  return port;
}

function ipToInt(ip: string): number {
  return ip
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .reduce((acc, part) => (acc << 8) + (part & 0xff), 0) >>> 0;
}

function isIpv4InCidr(ip: string, cidr: string): boolean {
  const match = IPV4_CIDR_REGEX.exec(cidr);
  if (!match) {
    return false;
  }
  const [, baseIp, bitsRaw] = match;
  const bits = Number.parseInt(bitsRaw, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const baseInt = ipToInt(baseIp) & mask;
  const ipInt = ipToInt(ip) & mask;
  return baseInt === ipInt;
}

function ensurePublicIpv4(address: string, label: string): void {
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(Number.parseInt(part, 10)))) {
    throw new UnsafeEndpointError('private_address', `${label}: invalid IPv4 address`);
  }
  if (BLOCKED_IPV4_CIDRS.some((cidr) => isIpv4InCidr(address, cidr))) {
    throw new UnsafeEndpointError(
      'private_address',
      `${label}: IPv4 address ${address} is not reachable from public internet`
    );
  }
}

function ensurePublicIpv6(address: string, label: string): void {
  let parsed: ipaddr.IPv6;
  try {
    const candidate = ipaddr.parse(address);
    if (candidate.kind() !== 'ipv6') {
      throw new Error('not IPv6');
    }
    parsed = candidate as ipaddr.IPv6;
  } catch {
    throw new UnsafeEndpointError('private_address', `${label}: invalid IPv6 address`);
  }
  if (parsed.isIPv4MappedAddress()) {
    ensurePublicIpv4(parsed.toIPv4Address().toString(), label);
    return;
  }
  if (parsed.range() !== 'unicast') {
    throw new UnsafeEndpointError(
      'private_address',
      `${label}: IPv6 address ${address} is not reachable from public internet`
    );
  }
}

async function resolveHost(
  host: string,
  allowIpv6: boolean,
  label: string,
  lookupHost: LookupFunction
): Promise<ResolvedAddress[]> {
  const ipType = isIP(host);
  if (ipType === 4) {
    ensurePublicIpv4(host, label);
    return [{ address: host, family: 4 }];
  }
  if (ipType === 6) {
    if (!allowIpv6) {
      throw new UnsafeEndpointError('ipv6_not_allowed', `${label}: IPv6 is not allowed`);
    }
    ensurePublicIpv6(host, label);
    return [{ address: host, family: 6 }];
  }

  try {
    const records = await lookupHost(host, { all: true, verbatim: true });
    if (!records || records.length === 0) {
      throw new UnsafeEndpointError(
        'resolve_failed',
        `${label}: failed to resolve host ${host}`
      );
    }
    const sanitized: ResolvedAddress[] = [];
    let hasIpv6Record = false;
    for (const record of records) {
      if (record.family === 6) {
        hasIpv6Record = true;
        if (!allowIpv6) {
          continue;
        }
        ensurePublicIpv6(record.address, label);
        sanitized.push({ address: record.address, family: 6 });
        continue;
      }
      ensurePublicIpv4(record.address, label);
      sanitized.push({ address: record.address, family: 4 });
    }
    if (sanitized.length === 0 && hasIpv6Record && !allowIpv6) {
      throw new UnsafeEndpointError('ipv6_not_allowed', `${label}: IPv6 is not allowed`);
    }
    return sanitized;
  } catch (error) {
    if (error instanceof UnsafeEndpointError) {
      throw error;
    }
    throw new UnsafeEndpointError(
      'resolve_failed',
      `${label}: DNS resolution failed for host ${host}`
    );
  }
}

export async function validateOutboundTarget(
  host: string,
  port: number,
  options: OutboundValidationOptions = {}
): Promise<OutboundTarget> {
  const label = options.label ?? 'Outbound target validation';
  const normalizedHost = ensureValidHost(host, label);
  const normalizedPort = ensureValidPort(port, label, options.allowedPorts);
  const addresses = await resolveHost(
    normalizedHost,
    Boolean(options.allowIpv6),
    label,
    options.lookup ?? lookup
  );

  return {
    host: normalizedHost,
    port: normalizedPort,
    addresses
  };
}

export { validateImageUpload, ImageValidationError } from './upload';
export type { SanitizedImage } from './upload';
export {
  cidrContains,
  CidrValidationError,
  normalizeIpAddress,
  normalizeIpOrCidr
} from './cidr';
export type { IpFamily, NormalizedCidr } from './cidr';
export { decryptSecret, encryptSecret, hashSecret, isEncryptedSecret } from './secrets';
