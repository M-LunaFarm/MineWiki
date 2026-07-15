export const PROTECTED_ROLE_CODES = ['owner', 'admin', 'wiki_admin'] as const;

const protectedRoleCodes = new Set<string>(PROTECTED_ROLE_CODES);

export function isProtectedRoleCode(roleCode: string): boolean {
  return protectedRoleCodes.has(roleCode);
}
