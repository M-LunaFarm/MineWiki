export const SUPPORTED_CLAIM_METHODS: readonly ['dns', 'motd'];

export type ClaimMethod = (typeof SUPPORTED_CLAIM_METHODS)[number];

export function isSupportedClaimMethod(value: string): value is ClaimMethod;
