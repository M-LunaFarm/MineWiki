import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { serialize } from 'cookie';
import { PrismaService } from '../common/prisma.service';

interface SessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  issuedAt: Date;
  expiresAt: Date;
  readonly token: string;
  tokenVersion: number;
  isElevated: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  lastActiveAt: Date;
}

export interface IssueSessionOptions {
  readonly userId: string;
  readonly ttlSeconds?: number;
  readonly elevated?: boolean;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface RotatedSession {
  readonly sessionId: string;
  readonly cookie: string;
  readonly expiresAt: string;
}

export interface SessionPayload {
  readonly sessionId: string;
  readonly userId: string;
  readonly isElevated: boolean;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly isCurrent: boolean;
  readonly tokenVersion: number;
  readonly isElevated: boolean;
}

const SESSION_COOKIE_NAME = 'mw_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async issueSession(options: IssueSessionOptions): Promise<RotatedSession> {
    const token = this.generateToken();
    const sessionId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
    );

    await this.prisma.session.create({
      data: {
        id: sessionId,
        accountId: options.userId,
        issuedAt,
        expiresAt,
        token,
        tokenVersion: 1,
        isElevated: Boolean(options.elevated),
        ipAddress: options.ipAddress ?? null,
        userAgent: options.userAgent ?? null,
        lastActiveAt: issuedAt
      }
    });

    return {
      sessionId,
      cookie: this.serializeCookie({
        sessionId,
        userId: options.userId,
        issuedAt,
        expiresAt,
        token,
        tokenVersion: 1,
        isElevated: Boolean(options.elevated),
        ipAddress: options.ipAddress ?? null,
        userAgent: options.userAgent ?? null,
        lastActiveAt: issuedAt
      }),
      expiresAt: expiresAt.toISOString()
    };
  }

  async rotateSession(sessionId: string, elevated = false): Promise<RotatedSession> {
    const current = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });
    if (!current) {
      throw new UnauthorizedException('?몄뀡??議댁옱?섏? ?딆뒿?덈떎.');
    }

    const token = this.generateToken();
    const issuedAt = new Date();
    const expirationMs = current.expiresAt.getTime() - current.issuedAt.getTime();
    const expiresAt = new Date(issuedAt.getTime() + expirationMs);

    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        token,
        issuedAt,
        expiresAt,
        tokenVersion: current.tokenVersion + 1,
        isElevated: elevated ? true : current.isElevated,
        lastActiveAt: issuedAt
      }
    });

    return {
      sessionId,
      cookie: this.serializeCookie({
        sessionId: updated.id,
        userId: updated.accountId,
        issuedAt: updated.issuedAt,
        expiresAt: updated.expiresAt,
        token: updated.token,
        tokenVersion: updated.tokenVersion,
        isElevated: updated.isElevated,
        ipAddress: updated.ipAddress,
        userAgent: updated.userAgent,
        lastActiveAt: updated.lastActiveAt
      }),
      expiresAt: updated.expiresAt.toISOString()
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.session
      .delete({ where: { id: sessionId } })
      .catch(() => undefined);
  }

  async revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });
    if (!session || session.accountId !== userId) {
      return;
    }
    await this.revokeSession(sessionId);
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.session.deleteMany({
      where: {
        accountId: userId,
        id: exceptSessionId ? { not: exceptSessionId } : undefined
      }
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const record = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });
    if (!record) {
      return undefined;
    }
    if (record.expiresAt.getTime() < Date.now()) {
      await this.revokeSession(sessionId);
      return undefined;
    }
    return {
      sessionId: record.id,
      userId: record.accountId,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      token: record.token,
      tokenVersion: record.tokenVersion,
      isElevated: record.isElevated,
      ipAddress: record.ipAddress,
      userAgent: record.userAgent,
      lastActiveAt: record.lastActiveAt
    };
  }

  async getSessionByToken(token: string | undefined): Promise<SessionRecord | undefined> {
    if (!token) {
      return undefined;
    }
    const record = await this.prisma.session.findUnique({
      where: { token }
    });
    if (!record) {
      return undefined;
    }
    return this.getSession(record.id);
  }

  toPayload(record: SessionRecord): SessionPayload {
    return {
      sessionId: record.sessionId,
      userId: record.userId,
      isElevated: record.isElevated
    };
  }

  async listSessionsForUser(
    userId: string,
    currentSessionId?: string
  ): Promise<SessionSummary[]> {
    const sessions = await this.prisma.session.findMany({
      where: { accountId: userId },
      orderBy: { lastActiveAt: 'desc' }
    });
    return sessions.map((session) => ({
      sessionId: session.id,
      createdAt: session.issuedAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      isCurrent: currentSessionId ? currentSessionId === session.id : false,
      tokenVersion: session.tokenVersion,
      isElevated: session.isElevated
    }));
  }

  async touchSession(
    sessionId: string,
    ipAddress?: string | null,
    userAgent?: string | null
  ): Promise<void> {
    const data: {
      lastActiveAt: Date;
      ipAddress?: string | null;
      userAgent?: string | null;
    } = {
      lastActiveAt: new Date()
    };
    if (ipAddress) {
      data.ipAddress = ipAddress;
    }
    if (userAgent) {
      data.userAgent = userAgent;
    }
    await this.prisma.session
      .update({
        where: { id: sessionId },
        data
      })
      .catch(() => undefined);
  }

  private serializeCookie(record: SessionRecord): string {
    return serialize(SESSION_COOKIE_NAME, record.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor((record.expiresAt.getTime() - Date.now()) / 1000),
      expires: record.expiresAt
    });
  }

  private generateToken(): string {
    return randomBytes(32).toString('base64url');
  }
}
