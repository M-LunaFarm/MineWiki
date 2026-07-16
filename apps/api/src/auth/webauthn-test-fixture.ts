import type { PrismaService } from '../common/prisma.service';

export interface TestAccount {
  id: string;
  canonicalAccountId: string | null;
  lifecycleStatus: string;
  displayName: string | null;
}

export interface TestSession {
  id: string;
  accountId: string;
  tokenVersion: number;
  expiresAt: Date;
}

export interface TestCredential {
  id: string;
  accountId: string;
  credentialId: string;
  name: string;
  publicKey: Uint8Array;
  counter: bigint;
  counterVersion: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

interface TestChallenge {
  id: string;
  accountId: string;
  sessionId: string;
  sessionTokenVersion: number;
  operation: string;
  purpose: string | null;
  challenge: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface TestTotpCredential {
  id: string;
  accountId: string;
  enabledAt: Date | null;
}

interface State {
  accounts: TestAccount[];
  links: Array<{ primaryAccountId: string; linkedAccountId: string }>;
  sessions: TestSession[];
  credentials: TestCredential[];
  challenges: TestChallenge[];
  totpCredentials: TestTotpCredential[];
  recoveryCodes: Array<{ accountId: string; usedAt: Date | null }>;
  protectedRoleAccountIds: string[];
  sequence: number;
}

export class MemoryPrisma {
  state: State;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(input: Partial<State> = {}) {
    this.state = {
      accounts: input.accounts ?? [],
      links: input.links ?? [],
      sessions: input.sessions ?? [],
      credentials: input.credentials ?? [],
      challenges: input.challenges ?? [],
      totpCredentials: input.totpCredentials ?? [],
      recoveryCodes: input.recoveryCodes ?? [],
      protectedRoleAccountIds: input.protectedRoleAccountIds ?? [],
      sequence: input.sequence ?? 0,
    };
  }

  asPrisma(): PrismaService {
    return this.client(() => this.state) as unknown as PrismaService;
  }

  private client(state: () => State): Record<string, unknown> {
    return {
      $transaction: async (write: (tx: Record<string, unknown>) => Promise<unknown>) => {
        let release!: () => void;
        const previous = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        const draft = cloneState(this.state);
        try {
          const result = await write(this.client(() => draft));
          this.state = draft;
          return result;
        } finally {
          release();
        }
      },
      $queryRaw: async (query: { values?: unknown[] }) => {
        const ids = (query.values ?? []).filter((value): value is string => typeof value === 'string');
        return state().accounts.filter((account) => ids.includes(account.id)).map(({ id }) => ({ id }));
      },
      account: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          state().accounts.find((account) => account.id === where.id) ?? null,
        findMany: async ({ where }: { where?: { OR?: Array<Record<string, { in?: string[] }>> } } = {}) => {
          const clauses = where?.OR ?? [];
          if (clauses.length === 0) return [...state().accounts];
          return state().accounts.filter((account) => clauses.some((clause) => {
            const idValues = clause.id?.in;
            const canonicalValues = clause.canonicalAccountId?.in;
            return Boolean(idValues?.includes(account.id) ||
              (account.canonicalAccountId && canonicalValues?.includes(account.canonicalAccountId)));
          }));
        },
        count: async ({ where }: { where: { id: { in: string[] }; lifecycleStatus?: string } }) =>
          state().accounts.filter((account) =>
            where.id.in.includes(account.id) &&
            (!where.lifecycleStatus || account.lifecycleStatus === where.lifecycleStatus),
          ).length,
      },
      accountLink: {
        findMany: async ({ where }: { where: { OR: Array<Record<string, { in: string[] }>> } }) =>
          state().links.filter((link) => where.OR.some((clause) =>
            clause.primaryAccountId?.in.includes(link.primaryAccountId) ||
            clause.linkedAccountId?.in.includes(link.linkedAccountId),
          )),
      },
      session: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          state().sessions.find((session) => matchesSession(session, where)) ?? null,
        findUnique: async ({ where }: { where: { id: string } }) =>
          state().sessions.find((session) => session.id === where.id) ?? null,
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const rows = state().sessions.filter((session) => matchesSession(session, where));
          for (const row of rows) {
            if (typeof data.tokenVersion === 'number') row.tokenVersion = data.tokenVersion;
            else if (isIncrement(data.tokenVersion)) row.tokenVersion += data.tokenVersion.increment;
          }
          return { count: rows.length };
        },
        deleteMany: async ({ where }: { where: { accountId: { in: string[] }; id?: { not: string } } }) => {
          const before = state().sessions.length;
          state().sessions = state().sessions.filter((session) =>
            !where.accountId.in.includes(session.accountId) || session.id === where.id?.not,
          );
          return { count: before - state().sessions.length };
        },
      },
      webAuthnChallenge: {
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const before = state().challenges.length;
          state().challenges = state().challenges.filter((challenge) => !matchesChallenge(challenge, where));
          return { count: before - state().challenges.length };
        },
        create: async ({ data }: { data: Omit<TestChallenge, 'id' | 'consumedAt' | 'createdAt'> }) => {
          const challenge: TestChallenge = {
            ...data,
            id: nextId(state(), 'challenge'),
            consumedAt: null,
            createdAt: new Date(),
          };
          state().challenges.push(challenge);
          return challenge;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { consumedAt: Date } }) => {
          const rows = state().challenges.filter((challenge) => matchesChallenge(challenge, where));
          for (const row of rows) row.consumedAt = data.consumedAt;
          return { count: rows.length };
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          state().challenges.find((challenge) => challenge.id === where.id) ?? null,
      },
      webAuthnCredential: {
        findMany: async ({ where }: { where: { accountId: string } }) =>
          state().credentials.filter((credential) => credential.accountId === where.accountId),
        findFirst: async ({ where }: { where: { id?: string; accountId?: string; credentialId?: string } }) =>
          state().credentials.find((credential) =>
            (!where.id || credential.id === where.id) &&
            (!where.accountId || credential.accountId === where.accountId) &&
            (!where.credentialId || credential.credentialId === where.credentialId),
          ) ?? null,
        count: async ({ where }: { where: { accountId: string } }) =>
          state().credentials.filter((credential) => credential.accountId === where.accountId).length,
        create: async ({ data }: { data: Omit<TestCredential, 'id' | 'counterVersion' | 'createdAt' | 'updatedAt' | 'lastUsedAt'> }) => {
          const duplicate = state().credentials.some((credential) =>
            credential.credentialId === data.credentialId ||
            (credential.accountId === data.accountId && credential.name.toLowerCase() === data.name.toLowerCase()),
          );
          if (duplicate) throw Object.assign(new Error('unique'), { code: 'P2002' });
          const now = new Date();
          const credential: TestCredential = {
            ...data,
            publicKey: Uint8Array.from(data.publicKey),
            transports: [...data.transports],
            id: nextId(state(), 'credential'),
            counterVersion: 0,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
          };
          state().credentials.push(credential);
          return credential;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const rows = state().credentials.filter((credential) => matchesCredential(credential, where));
          for (const row of rows) {
            if (typeof data.counter === 'bigint') row.counter = data.counter;
            if (isIncrement(data.counterVersion)) row.counterVersion += data.counterVersion.increment;
            if (typeof data.deviceType === 'string') row.deviceType = data.deviceType;
            if (typeof data.backedUp === 'boolean') row.backedUp = data.backedUp;
            if (data.lastUsedAt instanceof Date) row.lastUsedAt = data.lastUsedAt;
          }
          return { count: rows.length };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const index = state().credentials.findIndex((credential) => credential.id === where.id);
          if (index < 0) throw new Error('not found');
          return state().credentials.splice(index, 1)[0]!;
        },
      },
      mfaTotpCredential: {
        findUnique: async ({ where }: { where: { accountId?: string; id?: string } }) =>
          state().totpCredentials.find((credential) =>
            (!where.accountId || credential.accountId === where.accountId) &&
            (!where.id || credential.id === where.id),
          ) ?? null,
        delete: async ({ where }: { where: { id: string } }) => {
          const index = state().totpCredentials.findIndex((credential) => credential.id === where.id);
          if (index < 0) throw new Error('not found');
          return state().totpCredentials.splice(index, 1)[0]!;
        },
      },
      mfaRecoveryCode: {
        count: async ({ where }: { where: { accountId: string; usedAt: null } }) =>
          state().recoveryCodes.filter((code) => code.accountId === where.accountId && code.usedAt === null).length,
        deleteMany: async ({ where }: { where: { accountId: string } }) => {
          const before = state().recoveryCodes.length;
          state().recoveryCodes = state().recoveryCodes.filter((code) => code.accountId !== where.accountId);
          return { count: before - state().recoveryCodes.length };
        },
      },
      accountRole: {
        count: async ({ where }: { where: { accountId: { in: string[] } } }) =>
          state().protectedRoleAccountIds.filter((id) => where.accountId.in.includes(id)).length,
      },
    };
  }
}

function cloneState(state: State): State {
  return {
    accounts: state.accounts.map((row) => ({ ...row })),
    links: state.links.map((row) => ({ ...row })),
    sessions: state.sessions.map((row) => ({ ...row, expiresAt: new Date(row.expiresAt) })),
    credentials: state.credentials.map((row) => ({
      ...row,
      publicKey: Uint8Array.from(row.publicKey),
      transports: [...row.transports],
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
    })),
    challenges: state.challenges.map((row) => ({
      ...row,
      expiresAt: new Date(row.expiresAt),
      consumedAt: row.consumedAt ? new Date(row.consumedAt) : null,
      createdAt: new Date(row.createdAt),
    })),
    totpCredentials: state.totpCredentials.map((row) => ({
      ...row,
      enabledAt: row.enabledAt ? new Date(row.enabledAt) : null,
    })),
    recoveryCodes: state.recoveryCodes.map((row) => ({
      ...row,
      usedAt: row.usedAt ? new Date(row.usedAt) : null,
    })),
    protectedRoleAccountIds: [...state.protectedRoleAccountIds],
    sequence: state.sequence,
  };
}

function nextId(state: State, prefix: string): string {
  state.sequence += 1;
  return `${prefix}-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
}

function matchesSession(session: TestSession, where: Record<string, unknown>): boolean {
  if (typeof where.id === 'string' && session.id !== where.id) return false;
  if (typeof where.tokenVersion === 'number' && session.tokenVersion !== where.tokenVersion) return false;
  if (typeof where.accountId === 'string' && session.accountId !== where.accountId) return false;
  if (hasIn(where.accountId) && !where.accountId.in.includes(session.accountId)) return false;
  if (hasDateComparison(where.expiresAt, 'gt') && session.expiresAt.getTime() <= where.expiresAt.gt.getTime()) return false;
  return true;
}

function matchesChallenge(challenge: TestChallenge, where: Record<string, unknown>): boolean {
  if (typeof where.id === 'string' && challenge.id !== where.id) return false;
  if (typeof where.accountId === 'string' && challenge.accountId !== where.accountId) return false;
  if (typeof where.sessionId === 'string' && challenge.sessionId !== where.sessionId) return false;
  if (typeof where.sessionTokenVersion === 'number' && challenge.sessionTokenVersion !== where.sessionTokenVersion) return false;
  if (typeof where.operation === 'string' && challenge.operation !== where.operation) return false;
  if ('purpose' in where && challenge.purpose !== where.purpose) return false;
  if (where.consumedAt === null && challenge.consumedAt !== null) return false;
  if (hasNotNull(where.consumedAt) && challenge.consumedAt === null) return false;
  if (hasDateComparison(where.expiresAt, 'gt') && challenge.expiresAt.getTime() <= where.expiresAt.gt.getTime()) return false;
  if (hasDateComparison(where.expiresAt, 'lte') && challenge.expiresAt.getTime() > where.expiresAt.lte.getTime()) return false;
  if (Array.isArray(where.OR)) return where.OR.some((clause) => matchesChallenge(challenge, clause as Record<string, unknown>));
  return true;
}

function matchesCredential(credential: TestCredential, where: Record<string, unknown>): boolean {
  if (typeof where.id === 'string' && credential.id !== where.id) return false;
  if (typeof where.accountId === 'string' && credential.accountId !== where.accountId) return false;
  if (typeof where.credentialId === 'string' && credential.credentialId !== where.credentialId) return false;
  if (typeof where.counter === 'bigint' && credential.counter !== where.counter) return false;
  if (typeof where.counterVersion === 'number' && credential.counterVersion !== where.counterVersion) return false;
  return true;
}

function hasIn(value: unknown): value is { in: string[] } {
  return Boolean(value && typeof value === 'object' && 'in' in value && Array.isArray(value.in));
}

function hasDateComparison<Key extends 'gt' | 'lte'>(
  value: unknown,
  key: Key,
): value is Record<Key, Date> {
  const record = value as Record<string, unknown> | null;
  return Boolean(record && typeof record === 'object' && record[key] instanceof Date);
}

function hasNotNull(value: unknown): value is { not: null } {
  return Boolean(value && typeof value === 'object' && 'not' in value && value.not === null);
}

function isIncrement(value: unknown): value is { increment: number } {
  return Boolean(value && typeof value === 'object' && 'increment' in value && typeof value.increment === 'number');
}
