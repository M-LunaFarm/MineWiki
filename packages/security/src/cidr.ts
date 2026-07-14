import ipaddr = require('ipaddr.js');

export type IpFamily = 4 | 6;

export interface NormalizedCidr {
  readonly cidr: string;
  readonly address: string;
  readonly family: IpFamily;
  readonly prefixLength: number;
  readonly networkBytes: readonly number[];
}

export class CidrValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CidrValidationError';
  }
}

export function normalizeIpOrCidr(value: string, requireNetwork = false): NormalizedCidr {
  const input = value.trim();
  if (!input || input.length > 64) {
    throw new CidrValidationError('IP 주소 또는 CIDR을 입력하세요.');
  }

  try {
    const parsed = input.includes('/')
      ? ipaddr.parseCIDR(input)
      : [ipaddr.parse(input), undefined] as const;
    let address = parsed[0];
    let prefixLength = parsed[1];

    if (address.kind() === 'ipv6' && address.isIPv4MappedAddress?.()) {
      if (prefixLength !== undefined && prefixLength < 96) {
        throw new CidrValidationError('IPv4 매핑 IPv6 CIDR은 /96보다 작을 수 없습니다.');
      }
      address = address.toIPv4Address!();
      prefixLength = prefixLength === undefined ? undefined : prefixLength - 96;
    }

    const family: IpFamily = address.kind() === 'ipv4' ? 4 : 6;
    const maximumPrefix = family === 4 ? 32 : 128;
    const effectivePrefix = prefixLength ?? maximumPrefix;
    if (requireNetwork && !input.includes('/')) {
      throw new CidrValidationError('CIDR 접두사 길이가 필요합니다.');
    }
    if (!Number.isInteger(effectivePrefix) || effectivePrefix < 0 || effectivePrefix > maximumPrefix) {
      throw new CidrValidationError('CIDR 접두사 길이가 올바르지 않습니다.');
    }

    const networkBytes = maskNetwork(address.toByteArray(), effectivePrefix);
    const networkAddress = ipaddr.fromByteArray([...networkBytes]);
    const normalizedAddress = networkAddress.toString();
    return {
      cidr: `${normalizedAddress}/${effectivePrefix}`,
      address: normalizedAddress,
      family,
      prefixLength: effectivePrefix,
      networkBytes
    };
  } catch (error) {
    if (error instanceof CidrValidationError) throw error;
    throw new CidrValidationError('올바른 IPv4/IPv6 주소 또는 CIDR이 아닙니다.');
  }
}

export function normalizeIpAddress(value: string): string {
  const normalized = normalizeIpOrCidr(value);
  const maximumPrefix = normalized.family === 4 ? 32 : 128;
  if (normalized.prefixLength !== maximumPrefix) {
    throw new CidrValidationError('단일 IP 주소가 필요합니다.');
  }
  return normalized.address;
}

export function cidrContains(cidr: string, address: string): boolean {
  try {
    const network = normalizeIpOrCidr(cidr, true);
    const candidate = normalizeIpOrCidr(address);
    const maximumPrefix = candidate.family === 4 ? 32 : 128;
    if (candidate.prefixLength !== maximumPrefix || candidate.family !== network.family) return false;
    return prefixMatches(network.networkBytes, candidate.networkBytes, network.prefixLength);
  } catch {
    return false;
  }
}

function maskNetwork(bytes: readonly number[], prefixLength: number): number[] {
  return bytes.map((byte, index) => {
    const remainingBits = prefixLength - index * 8;
    if (remainingBits >= 8) return byte;
    if (remainingBits <= 0) return 0;
    return byte & (0xff << (8 - remainingBits));
  });
}

function prefixMatches(network: readonly number[], candidate: readonly number[], prefixLength: number): boolean {
  if (network.length !== candidate.length) return false;
  const completeBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < completeBytes; index += 1) {
    if (network[index] !== candidate[index]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits);
  return (network[completeBytes]! & mask) === (candidate[completeBytes]! & mask);
}
