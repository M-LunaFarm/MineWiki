import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createGuestSupportTicketSchema,
  createSupportMessageSchema,
  createSupportTicketSchema,
  supportTicketStatusSchema,
  updateSupportTicketSchema,
  type SupportMessage,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketListResponse,
  type SupportTicketStatus,
} from '@minewiki/schemas';
import { Prisma } from '@prisma/client';
import { CaptchaService } from '../captcha/captcha.service';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';

interface ListTicketOptions {
  readonly view?: string;
  readonly status?: string;
}

interface GuestTicketContext {
  readonly ipAddress?: string;
  readonly userAgent?: string | null;
}

type TicketView = 'mine' | 'assigned' | 'inbox';
type TicketPriority = SupportTicket['priority'];
type MessageAuthorRole = SupportMessage['authorRole'];

interface TicketRow {
  id: string;
  requesterAccountId: string;
  assigneeAccountId: string | null;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  lastMessageAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  requesterId: string;
  requesterDisplayName: string | null;
  requesterProviderUserId: string;
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  assigneeProviderUserId: string | null;
  serverId: string | null;
  serverName: string | null;
  latestMessagePreview: string | null;
  messageCount: number | bigint | string;
}

interface MessageRow {
  id: string;
  ticketId: string;
  authorAccountId: string | null;
  authorRole: string;
  body: string;
  isInternal: boolean | number | bigint | string;
  createdAt: Date | string;
  authorDisplayName: string | null;
  authorProviderUserId: string | null;
}

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);
  private readonly captchaRequired: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly captchaService: CaptchaService,
  ) {
    this.captchaRequired = this.captchaService.isCaptchaRequired();
  }

  async getViewerState(accountId: string): Promise<{ isAgent: boolean }> {
    return { isAgent: await this.isAgent(accountId) };
  }

  async listTickets(
    session: SessionPayload,
    options: ListTicketOptions = {},
  ): Promise<SupportTicketListResponse> {
    const isAgent = await this.isAgent(session.userId);
    const view = this.normalizeView(options.view, isAgent);
    const status = this.parseStatus(options.status);

    const whereClauses: Prisma.Sql[] = [];
    if (status) {
      whereClauses.push(Prisma.sql`t.status = ${status}`);
    }

    if (!isAgent || view === 'mine') {
      whereClauses.push(Prisma.sql`t.requesterAccountId = ${session.userId}`);
    } else if (view === 'assigned') {
      whereClauses.push(Prisma.sql`t.assigneeAccountId = ${session.userId}`);
    }

    const whereSql =
      whereClauses.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(whereClauses, ' AND ')}`
        : Prisma.empty;

    const visibilitySql = isAgent
      ? Prisma.empty
      : Prisma.sql`AND m.isInternal = false`;

    const rows = await this.prisma.$queryRaw<TicketRow[]>(Prisma.sql`
      SELECT
        t.id,
        t.requesterAccountId,
        t.assigneeAccountId,
        t.subject,
        t.status,
        t.priority,
        t.category,
        t.lastMessageAt,
        t.createdAt,
        t.updatedAt,
        req.id AS requesterId,
        req.displayName AS requesterDisplayName,
        req.providerUserId AS requesterProviderUserId,
        ass.id AS assigneeId,
        ass.displayName AS assigneeDisplayName,
        ass.providerUserId AS assigneeProviderUserId,
        srv.id AS serverId,
        srv.name AS serverName,
        (
          SELECT m.body
          FROM \`SupportMessage\` m
          WHERE m.ticketId = t.id
          ${visibilitySql}
          ORDER BY m.createdAt DESC
          LIMIT 1
        ) AS latestMessagePreview,
        (
          SELECT COUNT(*)
          FROM \`SupportMessage\` m
          WHERE m.ticketId = t.id
          ${visibilitySql}
        ) AS messageCount
      FROM \`SupportTicket\` t
      INNER JOIN \`Account\` req ON req.id = t.requesterAccountId
      LEFT JOIN \`Account\` ass ON ass.id = t.assigneeAccountId
      LEFT JOIN \`Server\` srv ON srv.id = t.serverId
      ${whereSql}
      ORDER BY t.lastMessageAt DESC, t.createdAt DESC
      LIMIT 100
    `);

    return {
      items: rows.map((row) => this.toTicket(row)),
      viewer: { isAgent },
    };
  }

  async getTicketDetail(
    session: SessionPayload,
    ticketId: string,
  ): Promise<SupportTicketDetail> {
    const isAgent = await this.isAgent(session.userId);
    const ticket = await this.fetchTicketRow(ticketId, isAgent);
    if (!ticket) {
      throw new NotFoundException('티켓을 찾을 수 없습니다.');
    }

    this.ensureTicketAccess(ticket, session.userId, isAgent);
    const messages = await this.fetchMessages(ticketId, isAgent);

    return {
      ticket: this.toTicket(ticket),
      messages: messages.map((message) => this.toMessage(message)),
      viewer: {
        isAgent,
        canManage: isAgent,
      },
    };
  }

  async createTicket(
    session: SessionPayload,
    payload: unknown,
  ): Promise<SupportTicketDetail> {
    const parsed = createSupportTicketSchema.parse(payload);
    const subject = parsed.subject.trim();
    const body = parsed.body.trim();
    const category = parsed.category?.trim() || null;

    if (!subject) {
      throw new BadRequestException('제목을 입력해 주세요.');
    }
    if (!body) {
      throw new BadRequestException('문의 내용을 입력해 주세요.');
    }

    const { assigneeAccountId, serverId } = await this.resolveTicketRouting(parsed.serverId);

    const ticketId = await this.createTicketRecords({
      requesterAccountId: session.userId,
      authorAccountId: session.userId,
      subject,
      body,
      category,
      priority: parsed.priority ?? 'normal',
      serverId,
      assigneeAccountId,
      authorRole: 'customer',
    });

    return this.getTicketDetail(session, ticketId);
  }

  async createGuestTicket(
    payload: unknown,
    context: GuestTicketContext = {},
  ): Promise<{ accepted: true; ticketId: string }> {
    const parsed = createGuestSupportTicketSchema.parse(payload);
    const subject = parsed.subject.trim();
    const body = parsed.body.trim();
    const category = parsed.category?.trim() || null;

    if (!subject) {
      throw new BadRequestException('제목을 입력해 주세요.');
    }
    if (!body) {
      throw new BadRequestException('문의 내용을 입력해 주세요.');
    }

    await this.verifyCaptchaToken(parsed.captchaToken, context.ipAddress);

    const { assigneeAccountId, serverId } = await this.resolveTicketRouting(parsed.serverId);
    const requesterAccountId = await this.resolveGuestRequesterAccountId();

    const guestName = parsed.guestName?.trim() || null;
    const guestEmail = parsed.guestEmail?.trim() || null;
    const guestMetaLines = [
      '[비로그인 문의]',
      `이름: ${guestName ?? '미입력'}`,
      `회신 이메일: ${guestEmail ?? '미입력'}`,
      '',
      body,
    ];
    const guestBody = clampText(guestMetaLines.join('\n'), 2000);

    const ticketId = await this.createTicketRecords({
      requesterAccountId,
      authorAccountId: null,
      subject: `[비회원] ${subject}`,
      body: guestBody,
      category,
      priority: parsed.priority ?? 'normal',
      serverId,
      assigneeAccountId,
      authorRole: 'customer',
    });

    this.logger.log(
      `Guest support ticket created: ${ticketId} (ip=${context.ipAddress ?? 'n/a'})`,
    );

    return {
      accepted: true,
      ticketId,
    };
  }

  async createMessage(
    session: SessionPayload,
    ticketId: string,
    payload: unknown,
  ): Promise<SupportTicketDetail> {
    const parsed = createSupportMessageSchema.parse(payload);
    const body = parsed.body.trim();
    if (!body) {
      throw new BadRequestException('메시지 내용을 입력해 주세요.');
    }

    const isAgent = await this.isAgent(session.userId);
    const ticket = await this.fetchTicketRow(ticketId, true);
    if (!ticket) {
      throw new NotFoundException('티켓을 찾을 수 없습니다.');
    }

    this.ensureTicketAccess(ticket, session.userId, isAgent);

    const isInternal = Boolean(parsed.isInternal);
    if (isInternal && !isAgent) {
      throw new ForbiddenException('내부 메모는 상담원만 작성할 수 있습니다.');
    }

    const nextStatus: SupportTicketStatus =
      !isAgent && (ticket.status === 'resolved' || ticket.status === 'closed')
        ? 'open'
        : normalizeStatus(ticket.status);

    const authorRole: MessageAuthorRole = isAgent ? 'agent' : 'customer';
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO \`SupportMessage\` (
          id,
          ticketId,
          authorAccountId,
          authorRole,
          body,
          isInternal,
          createdAt
        ) VALUES (
          ${randomUUID()},
          ${ticketId},
          ${session.userId},
          ${authorRole},
          ${body},
          ${isAgent ? isInternal : false},
          ${now}
        )
      `,
      this.prisma.$executeRaw`
        UPDATE \`SupportTicket\`
        SET lastMessageAt = ${now}, status = ${nextStatus}, updatedAt = ${now}
        WHERE id = ${ticketId}
      `,
    ]);

    return this.getTicketDetail(session, ticketId);
  }

  async updateTicket(
    session: SessionPayload,
    ticketId: string,
    payload: unknown,
  ): Promise<SupportTicketDetail> {
    const isAgent = await this.isAgent(session.userId);
    if (!isAgent) {
      throw new ForbiddenException('티켓 상태 변경은 상담원만 가능합니다.');
    }

    const parsed = updateSupportTicketSchema.parse(payload);

    const existing = await this.fetchTicketRow(ticketId, true);
    if (!existing) {
      throw new NotFoundException('티켓을 찾을 수 없습니다.');
    }

    if (parsed.assigneeAccountId !== undefined && parsed.assigneeAccountId !== null) {
      const assigneeIsAgent = await this.isAgent(parsed.assigneeAccountId);
      if (!assigneeIsAgent) {
        throw new BadRequestException('상담원으로 등록된 계정만 배정할 수 있습니다.');
      }
    }

    const now = new Date();
    const updates: Prisma.Sql[] = [Prisma.sql`updatedAt = ${now}`];

    if (parsed.status !== undefined) {
      updates.push(Prisma.sql`status = ${parsed.status}`);
    }
    if (parsed.priority !== undefined) {
      updates.push(Prisma.sql`priority = ${parsed.priority}`);
    }
    if (parsed.assigneeAccountId !== undefined) {
      updates.push(Prisma.sql`assigneeAccountId = ${parsed.assigneeAccountId}`);
    }
    if (parsed.category !== undefined) {
      updates.push(Prisma.sql`category = ${parsed.category}`);
    }

    await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE \`SupportTicket\`
        SET ${Prisma.join(updates, ', ')}
        WHERE id = ${ticketId}
      `,
    );

    return this.getTicketDetail(session, ticketId);
  }

  private async createTicketRecords(input: {
    requesterAccountId: string;
    authorAccountId: string | null;
    subject: string;
    body: string;
    category: string | null;
    priority: TicketPriority;
    serverId: string | null;
    assigneeAccountId: string | null;
    authorRole: MessageAuthorRole;
  }): Promise<string> {
    const now = new Date();
    const ticketId = randomUUID();
    const messageId = randomUUID();

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO \`SupportTicket\` (
          id,
          requesterAccountId,
          assigneeAccountId,
          serverId,
          subject,
          status,
          priority,
          category,
          lastMessageAt,
          createdAt,
          updatedAt
        ) VALUES (
          ${ticketId},
          ${input.requesterAccountId},
          ${input.assigneeAccountId},
          ${input.serverId},
          ${input.subject},
          ${'open'},
          ${input.priority},
          ${input.category},
          ${now},
          ${now},
          ${now}
        )
      `;

      await tx.$executeRaw`
        INSERT INTO \`SupportMessage\` (
          id,
          ticketId,
          authorAccountId,
          authorRole,
          body,
          isInternal,
          createdAt
        ) VALUES (
          ${messageId},
          ${ticketId},
          ${input.authorAccountId},
          ${input.authorRole},
          ${input.body},
          ${false},
          ${now}
        )
      `;
    });

    return ticketId;
  }

  private async resolveTicketRouting(
    serverId: string | null | undefined,
  ): Promise<{ assigneeAccountId: string | null; serverId: string | null }> {
    let assigneeAccountId: string | null = null;
    let normalizedServerId: string | null = null;

    if (serverId) {
      const server = await this.prisma.server.findUnique({
        where: { id: serverId },
        select: {
          id: true,
          ownerAccountId: true,
        },
      });
      if (!server) {
        throw new NotFoundException('연결할 서버를 찾을 수 없습니다.');
      }
      normalizedServerId = server.id;
      if (server.ownerAccountId && (await this.isAgent(server.ownerAccountId))) {
        assigneeAccountId = server.ownerAccountId;
      }
    }

    return {
      assigneeAccountId,
      serverId: normalizedServerId,
    };
  }

  private async resolveGuestRequesterAccountId(): Promise<string> {
    const guest = await this.prisma.account.upsert({
      where: {
        provider_providerUserId: {
          provider: 'email',
          providerUserId: 'support-guest',
        },
      },
      update: {
        displayName: '비회원 문의',
      },
      create: {
        provider: 'email',
        providerUserId: 'support-guest',
        displayName: '비회원 문의',
      },
      select: {
        id: true,
      },
    });

    return guest.id;
  }

  private async verifyCaptchaToken(
    captchaToken?: string | null,
    ipAddress?: string,
  ): Promise<void> {
    if (!this.captchaRequired) {
      return;
    }
    const result = await this.captchaService.verifyCaptcha(captchaToken, ipAddress);
    if (!result.success) {
      this.logger.warn(
        { ipAddress, errors: result.errors },
        'Support guest captcha verification failed',
      );
      throw new ForbiddenException('CAPTCHA 검증에 실패했습니다. 다시 시도해 주세요.');
    }
  }

  private async isAgent(accountId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ accountId: string }>>(Prisma.sql`
      SELECT accountId
      FROM \`SupportAgent\`
      WHERE accountId = ${accountId}
      LIMIT 1
    `);
    return rows.length > 0;
  }

  private normalizeView(view: string | undefined, isAgent: boolean): TicketView {
    if (!isAgent) {
      return 'mine';
    }
    if (view === 'mine' || view === 'assigned' || view === 'inbox') {
      return view;
    }
    return 'inbox';
  }

  private parseStatus(status: string | undefined): SupportTicketStatus | undefined {
    if (!status) {
      return undefined;
    }
    const parsed = supportTicketStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw new BadRequestException('지원하지 않는 티켓 상태입니다.');
    }
    return parsed.data;
  }

  private ensureTicketAccess(
    ticket: { requesterAccountId: string; assigneeAccountId: string | null },
    userId: string,
    isAgent: boolean,
  ): void {
    if (isAgent) {
      return;
    }
    if (ticket.requesterAccountId === userId || ticket.assigneeAccountId === userId) {
      return;
    }
    throw new ForbiddenException('해당 티켓에 접근할 권한이 없습니다.');
  }

  private async fetchTicketRow(
    ticketId: string,
    isAgent: boolean,
  ): Promise<TicketRow | null> {
    const visibilitySql = isAgent
      ? Prisma.empty
      : Prisma.sql`AND m.isInternal = false`;

    const rows = await this.prisma.$queryRaw<TicketRow[]>(Prisma.sql`
      SELECT
        t.id,
        t.requesterAccountId,
        t.assigneeAccountId,
        t.subject,
        t.status,
        t.priority,
        t.category,
        t.lastMessageAt,
        t.createdAt,
        t.updatedAt,
        req.id AS requesterId,
        req.displayName AS requesterDisplayName,
        req.providerUserId AS requesterProviderUserId,
        ass.id AS assigneeId,
        ass.displayName AS assigneeDisplayName,
        ass.providerUserId AS assigneeProviderUserId,
        srv.id AS serverId,
        srv.name AS serverName,
        (
          SELECT m.body
          FROM \`SupportMessage\` m
          WHERE m.ticketId = t.id
          ${visibilitySql}
          ORDER BY m.createdAt DESC
          LIMIT 1
        ) AS latestMessagePreview,
        (
          SELECT COUNT(*)
          FROM \`SupportMessage\` m
          WHERE m.ticketId = t.id
          ${visibilitySql}
        ) AS messageCount
      FROM \`SupportTicket\` t
      INNER JOIN \`Account\` req ON req.id = t.requesterAccountId
      LEFT JOIN \`Account\` ass ON ass.id = t.assigneeAccountId
      LEFT JOIN \`Server\` srv ON srv.id = t.serverId
      WHERE t.id = ${ticketId}
      LIMIT 1
    `);

    return rows[0] ?? null;
  }

  private async fetchMessages(ticketId: string, isAgent: boolean): Promise<MessageRow[]> {
    const whereInternal = isAgent ? Prisma.empty : Prisma.sql`AND m.isInternal = false`;

    return this.prisma.$queryRaw<MessageRow[]>(Prisma.sql`
      SELECT
        m.id,
        m.ticketId,
        m.authorAccountId,
        m.authorRole,
        m.body,
        m.isInternal,
        m.createdAt,
        a.displayName AS authorDisplayName,
        a.providerUserId AS authorProviderUserId
      FROM \`SupportMessage\` m
      LEFT JOIN \`Account\` a ON a.id = m.authorAccountId
      WHERE m.ticketId = ${ticketId}
      ${whereInternal}
      ORDER BY m.createdAt ASC
    `);
  }

  private toTicket(row: TicketRow): SupportTicket {
    return {
      id: row.id,
      subject: row.subject,
      status: normalizeStatus(row.status),
      priority: normalizePriority(row.priority),
      category: row.category,
      lastMessageAt: toIsoString(row.lastMessageAt),
      createdAt: toIsoString(row.createdAt),
      updatedAt: toIsoString(row.updatedAt),
      requester: {
        id: row.requesterId,
        displayName: toAccountDisplayName(
          row.requesterDisplayName,
          row.requesterProviderUserId,
          '고객',
        ),
      },
      assignee: row.assigneeId
        ? {
            id: row.assigneeId,
            displayName: toAccountDisplayName(
              row.assigneeDisplayName,
              row.assigneeProviderUserId,
              '상담원',
            ),
          }
        : null,
      server: row.serverId
        ? {
            id: row.serverId,
            name: row.serverName ?? '연결된 서버',
          }
        : null,
      latestMessagePreview: row.latestMessagePreview
        ? clampText(row.latestMessagePreview, 180)
        : null,
      messageCount: toCount(row.messageCount),
    };
  }

  private toMessage(row: MessageRow): SupportMessage {
    const role = normalizeAuthorRole(row.authorRole);
    return {
      id: row.id,
      ticketId: row.ticketId,
      authorAccountId: row.authorAccountId,
      authorDisplayName: toMessageAuthorDisplayName(
        row.authorDisplayName,
        row.authorProviderUserId,
        role,
      ),
      authorRole: role,
      body: row.body,
      isInternal: toBoolean(row.isInternal),
      createdAt: toIsoString(row.createdAt),
    };
  }
}

function normalizeStatus(value: string): SupportTicketStatus {
  if (value === 'open' || value === 'pending' || value === 'resolved' || value === 'closed') {
    return value;
  }
  return 'open';
}

function normalizePriority(value: string): TicketPriority {
  if (value === 'low' || value === 'normal' || value === 'high' || value === 'urgent') {
    return value;
  }
  return 'normal';
}

function normalizeAuthorRole(value: string): MessageAuthorRole {
  if (value === 'customer' || value === 'agent' || value === 'system') {
    return value;
  }
  return 'system';
}

function toMessageAuthorDisplayName(
  displayName: string | null,
  providerUserId: string | null,
  role: MessageAuthorRole,
): string {
  if (role === 'system') {
    return '시스템';
  }
  if (role === 'customer' && !displayName?.trim() && !providerUserId) {
    return '비회원';
  }
  return toAccountDisplayName(
    displayName,
    providerUserId,
    role === 'agent' ? '상담원' : '고객',
  );
}

function toAccountDisplayName(
  displayName: string | null,
  providerUserId: string | null,
  fallback: string,
): string {
  const name = displayName?.trim();
  if (name) {
    return name;
  }
  const suffix = providerUserId?.slice(0, 6) ?? 'user';
  return `${fallback}-${suffix}`;
}

function toCount(value: number | bigint | string): number {
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return Number.isFinite(value) ? value : 0;
}

function toBoolean(value: boolean | number | bigint | string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true';
  }
  if (typeof value === 'bigint') {
    return value === 1n;
  }
  return value === 1;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function clampText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}
