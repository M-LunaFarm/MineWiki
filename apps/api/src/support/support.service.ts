import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createGuestSupportTicketSchema,
  createSupportMessageSchema,
  createSupportTicketSchema,
  guestSupportAccessSchema,
  guestSupportMessageSchema,
  guestSupportRecoverySchema,
  supportTicketStatusSchema,
  updateSupportTicketSchema,
  type SupportMessage,
  type SupportServerOption,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketListResponse,
  type SupportTicketStatus,
} from '@minewiki/schemas';
import { Prisma } from '@prisma/client';
import { CaptchaService } from '../captcha/captcha.service';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { RoleService } from '../roles/role.service';

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
  pageId: string | null;
  verifySessionId: string | null;
  pluginServerId: string | null;
  fileId: string | null;
  guestName: string | null;
  guestEmail: string | null;
  guestAccessHash: string | null;
  guestAccessExpiresAt: Date | string | null;
  firstResponseAt: Date | string | null;
  resolvedAt: Date | string | null;
  lastCustomerMessageAt: Date | string | null;
  lastAgentMessageAt: Date | string | null;
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
  serverJoinHost: string | null;
  serverJoinPort: number | bigint | string | null;
  serverEdition: string | null;
  serverListingStatus: string | null;
  serverNameSnapshot: string | null;
  serverJoinHostSnapshot: string | null;
  serverJoinPortSnapshot: number | bigint | string | null;
  serverEditionSnapshot: string | null;
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
    @Optional() private readonly roles?: RoleService,
  ) {
    this.captchaRequired = this.captchaService.isCaptchaRequired();
  }

  async getViewerState(accountId: string): Promise<{ isAgent: boolean }> {
    return { isAgent: await this.isAgent(accountId) };
  }

  async listServerOptions(
    accountId?: string,
    search?: string,
  ): Promise<{ items: SupportServerOption[] }> {
    const keyword = search?.trim().slice(0, 80);
    const isAgent = accountId ? await this.isAgent(accountId) : false;
    const identityFilter = accountId
      ? Prisma.sql`(s.ownerAccountId = ${accountId} OR s.registrantAccountId = ${accountId})`
      : Prisma.sql`FALSE`;
    const visibilityFilter = isAgent
      ? Prisma.sql`TRUE`
      : keyword
        ? Prisma.sql`(s.listingStatus = 'active' OR ${identityFilter})`
        : identityFilter;
    const searchFilter = keyword
      ? Prisma.sql`AND (s.name LIKE ${`%${keyword}%`} OR s.joinHost LIKE ${`%${keyword}%`})`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      name: string;
      joinHost: string;
      joinPort: number | bigint | string;
      edition: string;
      listingStatus: string;
      ownerAccountId: string | null;
      registrantAccountId: string | null;
    }>>(Prisma.sql`
      SELECT
        s.id,
        s.name,
        s.joinHost,
        s.joinPort,
        s.edition,
        s.listingStatus,
        s.ownerAccountId,
        s.registrantAccountId
      FROM \`Server\` s
      WHERE ${visibilityFilter}
      ${searchFilter}
      ORDER BY
        CASE
          WHEN s.ownerAccountId = ${accountId ?? ''} THEN 0
          WHEN s.registrantAccountId = ${accountId ?? ''} THEN 1
          WHEN s.listingStatus = 'active' THEN 2
          ELSE 3
        END,
        s.name ASC
      LIMIT 25
    `);

    return {
      items: rows.map((server) => ({
        id: server.id,
        name: server.name,
        joinHost: server.joinHost,
        joinPort: Number(server.joinPort),
        edition: server.edition === 'bedrock' ? 'bedrock' : 'java',
        listingStatus: normalizeServerListingStatus(server.listingStatus),
        relationship: isAgent
          ? 'staff'
          : server.ownerAccountId === accountId
            ? 'owner'
            : server.registrantAccountId === accountId
              ? 'registrant'
              : 'public',
      })),
    };
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
        t.pageId,
        t.verifySessionId,
        t.pluginServerId,
        t.fileId,
        t.guestName,
        t.guestEmail,
        t.guestAccessHash,
        t.guestAccessExpiresAt,
        t.firstResponseAt,
        t.resolvedAt,
        t.lastCustomerMessageAt,
        t.lastAgentMessageAt,
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
        srv.joinHost AS serverJoinHost,
        srv.joinPort AS serverJoinPort,
        srv.edition AS serverEdition,
        srv.listingStatus AS serverListingStatus,
        t.serverNameSnapshot,
        t.serverJoinHostSnapshot,
        t.serverJoinPortSnapshot,
        t.serverEditionSnapshot,
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
    const ticketContext = normalizeTicketContext(parsed);

    if (!subject) {
      throw new BadRequestException('제목을 입력해 주세요.');
    }
    if (!body) {
      throw new BadRequestException('문의 내용을 입력해 주세요.');
    }

    const routing = await this.resolveTicketRouting(parsed.serverId, session.userId);

    const ticketId = await this.createTicketRecords({
      requesterAccountId: session.userId,
      authorAccountId: session.userId,
      subject,
      body,
      category,
      priority: parsed.priority ?? 'normal',
      ...routing,
      ...ticketContext,
      authorRole: 'customer',
    });

    return this.getTicketDetail(session, ticketId);
  }

  async createGuestTicket(
    payload: unknown,
    context: GuestTicketContext = {},
  ): Promise<{
    accepted: true;
    ticketId: string;
    accessCode: string;
    accessExpiresAt: string;
  }> {
    const parsed = createGuestSupportTicketSchema.parse(payload);
    const subject = parsed.subject.trim();
    const body = parsed.body.trim();
    const category = parsed.category?.trim() || null;
    const ticketContext = normalizeTicketContext(parsed);

    if (!subject) {
      throw new BadRequestException('제목을 입력해 주세요.');
    }
    if (!body) {
      throw new BadRequestException('문의 내용을 입력해 주세요.');
    }

    await this.verifyCaptchaToken(parsed.captchaToken, context.ipAddress);

    const routing = await this.resolveTicketRouting(parsed.serverId);
    const requesterAccountId = await this.resolveGuestRequesterAccountId();

    const guestName = parsed.guestName?.trim() || null;
    const guestEmail = parsed.guestEmail?.trim() || null;
    const accessCode = randomBytes(32).toString('base64url');
    const guestAccessHash = hashGuestAccessCode(accessCode);
    const guestAccessExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90);

    const ticketId = await this.createTicketRecords({
      requesterAccountId,
      authorAccountId: null,
      subject: `[비회원] ${subject}`,
      body,
      category,
      priority: parsed.priority ?? 'normal',
      ...routing,
      ...ticketContext,
      authorRole: 'customer',
      guestName,
      guestEmail,
      guestAccessHash,
      guestAccessExpiresAt,
    });

    this.logger.log(`Guest support ticket created: ${ticketId}`);

    return {
      accepted: true,
      ticketId,
      accessCode,
      accessExpiresAt: guestAccessExpiresAt.toISOString(),
    };
  }

  async getGuestTicketDetail(payload: unknown): Promise<SupportTicketDetail> {
    const parsed = guestSupportAccessSchema.parse(payload);
    const ticket = await this.requireGuestTicketAccess(parsed.ticketId, parsed.accessCode);
    const messages = await this.fetchMessages(parsed.ticketId, false);

    return {
      ticket: this.toTicket(ticket),
      messages: messages.map((message) => this.toMessage(message)),
      viewer: {
        isAgent: false,
        canManage: false,
      },
    };
  }

  async recoverGuestTicket(
    payload: unknown,
    context: GuestTicketContext = {},
  ): Promise<{
    ticketId: string;
    accessCode: string;
    accessExpiresAt: string;
    detail: SupportTicketDetail;
  }> {
    const parsed = guestSupportRecoverySchema.parse(payload);
    await this.verifyCaptchaToken(parsed.captchaToken, context.ipAddress);

    const ticket = await this.fetchTicketRow(parsed.ticketId, false);
    const storedEmail = ticket?.guestEmail?.trim().toLowerCase();
    const suppliedEmail = parsed.email.trim().toLowerCase();
    if (!ticket || !storedEmail || storedEmail !== suppliedEmail) {
      throw new ForbiddenException('문의 번호 또는 회신 이메일이 올바르지 않습니다.');
    }

    const accessCode = randomBytes(32).toString('base64url');
    const accessHash = hashGuestAccessCode(accessCode);
    const accessExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90);
    await this.prisma.$executeRaw`
      UPDATE \`SupportTicket\`
      SET
        guestAccessHash = ${accessHash},
        guestAccessExpiresAt = ${accessExpiresAt},
        updatedAt = ${new Date()}
      WHERE id = ${parsed.ticketId}
    `;

    return {
      ticketId: parsed.ticketId,
      accessCode,
      accessExpiresAt: accessExpiresAt.toISOString(),
      detail: await this.getGuestTicketDetail({
        ticketId: parsed.ticketId,
        accessCode,
      }),
    };
  }

  async createGuestMessage(ticketId: string, payload: unknown): Promise<SupportTicketDetail> {
    const parsed = guestSupportMessageSchema.parse(payload);
    const ticket = await this.requireGuestTicketAccess(ticketId, parsed.accessCode);
    const body = parsed.body.trim();
    if (!body) {
      throw new BadRequestException('메시지 내용을 입력해 주세요.');
    }

    const now = new Date();
    const nextStatus: SupportTicketStatus =
      ticket.status === 'resolved' || ticket.status === 'closed'
        ? 'open'
        : normalizeStatus(ticket.status);

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
          ${null},
          ${'customer'},
          ${body},
          ${false},
          ${now}
        )
      `,
      this.prisma.$executeRaw`
        UPDATE \`SupportTicket\`
        SET
          lastMessageAt = ${now},
          lastCustomerMessageAt = ${now},
          resolvedAt = ${null},
          status = ${nextStatus},
          updatedAt = ${now}
        WHERE id = ${ticketId}
      `,
    ]);

    return this.getGuestTicketDetail({
      ticketId,
      accessCode: parsed.accessCode,
    });
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
        SET
          lastMessageAt = ${now},
          status = ${nextStatus},
          updatedAt = ${now}
          ${
            isAgent && !isInternal
              ? Prisma.sql`,
                firstResponseAt = COALESCE(firstResponseAt, ${now}),
                lastAgentMessageAt = ${now}`
              : !isAgent
                ? Prisma.sql`,
                  lastCustomerMessageAt = ${now},
                  resolvedAt = ${null}`
                : Prisma.empty
          }
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
      updates.push(
        parsed.status === 'resolved' || parsed.status === 'closed'
          ? Prisma.sql`resolvedAt = COALESCE(resolvedAt, ${now})`
          : Prisma.sql`resolvedAt = ${null}`,
      );
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
    serverNameSnapshot: string | null;
    serverJoinHostSnapshot: string | null;
    serverJoinPortSnapshot: number | null;
    serverEditionSnapshot: 'java' | 'bedrock' | null;
    pageId: string | null;
    verifySessionId: string | null;
    pluginServerId: string | null;
    fileId: string | null;
    assigneeAccountId: string | null;
    authorRole: MessageAuthorRole;
    guestName?: string | null;
    guestEmail?: string | null;
    guestAccessHash?: string | null;
    guestAccessExpiresAt?: Date | null;
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
          serverNameSnapshot,
          serverJoinHostSnapshot,
          serverJoinPortSnapshot,
          serverEditionSnapshot,
          subject,
          status,
          priority,
          category,
          pageId,
          verifySessionId,
          pluginServerId,
          fileId,
          guestName,
          guestEmail,
          guestAccessHash,
          guestAccessExpiresAt,
          lastCustomerMessageAt,
          lastMessageAt,
          createdAt,
          updatedAt
        ) VALUES (
          ${ticketId},
          ${input.requesterAccountId},
          ${input.assigneeAccountId},
          ${input.serverId},
          ${input.serverNameSnapshot},
          ${input.serverJoinHostSnapshot},
          ${input.serverJoinPortSnapshot},
          ${input.serverEditionSnapshot},
          ${input.subject},
          ${'open'},
          ${input.priority},
          ${input.category},
          ${input.pageId},
          ${input.verifySessionId},
          ${input.pluginServerId},
          ${input.fileId},
          ${input.guestName ?? null},
          ${input.guestEmail ?? null},
          ${input.guestAccessHash ?? null},
          ${input.guestAccessExpiresAt ?? null},
          ${now},
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
    actorAccountId?: string,
  ): Promise<{
    assigneeAccountId: string | null;
    serverId: string | null;
    serverNameSnapshot: string | null;
    serverJoinHostSnapshot: string | null;
    serverJoinPortSnapshot: number | null;
    serverEditionSnapshot: 'java' | 'bedrock' | null;
  }> {
    let assigneeAccountId: string | null = null;
    let normalizedServerId: string | null = null;
    let serverNameSnapshot: string | null = null;
    let serverJoinHostSnapshot: string | null = null;
    let serverJoinPortSnapshot: number | null = null;
    let serverEditionSnapshot: 'java' | 'bedrock' | null = null;

    if (serverId) {
      const server = await this.prisma.server.findUnique({
        where: { id: serverId },
        select: {
          id: true,
          name: true,
          joinHost: true,
          joinPort: true,
          edition: true,
          listingStatus: true,
          ownerAccountId: true,
          registrantAccountId: true,
        },
      });
      if (!server) {
        throw new NotFoundException('연결할 서버를 찾을 수 없습니다.');
      }
      const actorIsAgent = actorAccountId ? await this.isAgent(actorAccountId) : false;
      const canReference =
        server.listingStatus === 'active' ||
        actorIsAgent ||
        (Boolean(actorAccountId) &&
          (server.ownerAccountId === actorAccountId ||
            server.registrantAccountId === actorAccountId));
      if (!canReference) {
        throw new ForbiddenException('이 문의에 연결할 수 없는 서버입니다.');
      }
      normalizedServerId = server.id;
      serverNameSnapshot = server.name;
      serverJoinHostSnapshot = server.joinHost;
      serverJoinPortSnapshot = server.joinPort;
      serverEditionSnapshot = server.edition;
      if (server.ownerAccountId && (await this.isAgent(server.ownerAccountId))) {
        assigneeAccountId = server.ownerAccountId;
      }
    }

    return {
      assigneeAccountId,
      serverId: normalizedServerId,
      serverNameSnapshot,
      serverJoinHostSnapshot,
      serverJoinPortSnapshot,
      serverEditionSnapshot,
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
    if (await this.roles?.hasPermission(accountId, 'support.admin').catch(() => false)) {
      return true;
    }
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
    if (ticket.requesterAccountId === userId) {
      return;
    }
    throw new ForbiddenException('해당 티켓에 접근할 권한이 없습니다.');
  }

  private async requireGuestTicketAccess(
    ticketId: string,
    accessCode: string,
  ): Promise<TicketRow> {
    const ticket = await this.fetchTicketRow(ticketId, false);
    if (!ticket?.guestAccessHash || !ticket.guestAccessExpiresAt) {
      throw new NotFoundException('조회 가능한 비회원 문의를 찾을 수 없습니다.');
    }

    const expiresAt = new Date(ticket.guestAccessExpiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException('비회원 문의 조회 기간이 만료되었습니다.');
    }

    const expected = Buffer.from(ticket.guestAccessHash, 'hex');
    const actual = Buffer.from(hashGuestAccessCode(accessCode), 'hex');
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new ForbiddenException('문의 번호 또는 조회 코드가 올바르지 않습니다.');
    }
    return ticket;
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
        t.pageId,
        t.verifySessionId,
        t.pluginServerId,
        t.fileId,
        t.guestName,
        t.guestEmail,
        t.guestAccessHash,
        t.guestAccessExpiresAt,
        t.firstResponseAt,
        t.resolvedAt,
        t.lastCustomerMessageAt,
        t.lastAgentMessageAt,
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
        srv.joinHost AS serverJoinHost,
        srv.joinPort AS serverJoinPort,
        srv.edition AS serverEdition,
        srv.listingStatus AS serverListingStatus,
        t.serverNameSnapshot,
        t.serverJoinHostSnapshot,
        t.serverJoinPortSnapshot,
        t.serverEditionSnapshot,
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
      pageId: row.pageId,
      verifySessionId: row.verifySessionId,
      pluginServerId: row.pluginServerId,
      fileId: row.fileId,
      lastMessageAt: toIsoString(row.lastMessageAt),
      createdAt: toIsoString(row.createdAt),
      updatedAt: toIsoString(row.updatedAt),
      requester: {
        id: row.requesterId,
        displayName: toAccountDisplayName(
          row.guestName ?? row.requesterDisplayName,
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
      server: row.serverId || row.serverNameSnapshot
        ? {
            id: row.serverId,
            name: row.serverName ?? row.serverNameSnapshot ?? '삭제된 서버',
            joinHost: row.serverJoinHost ?? row.serverJoinHostSnapshot,
            joinPort: toNullableNumber(row.serverJoinPort ?? row.serverJoinPortSnapshot),
            edition: normalizeServerEdition(row.serverEdition ?? row.serverEditionSnapshot),
            listingStatus: row.serverId
              ? normalizeServerListingStatus(row.serverListingStatus)
              : 'deleted',
          }
        : null,
      contactEmail: row.guestEmail,
      latestMessagePreview: row.latestMessagePreview
        ? clampText(row.latestMessagePreview, 180)
        : null,
      messageCount: toCount(row.messageCount),
      sla: calculateSupportTicketSla(row),
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

function hashGuestAccessCode(accessCode: string): string {
  return createHash('sha256').update(accessCode, 'utf8').digest('hex');
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

const SUPPORT_FIRST_RESPONSE_TARGET_MINUTES: Readonly<Record<TicketPriority, number>> = {
  urgent: 60,
  high: 4 * 60,
  normal: 24 * 60,
  low: 48 * 60,
};

export function calculateSupportTicketSla(
  row: Pick<
    TicketRow,
    | 'priority'
    | 'createdAt'
    | 'firstResponseAt'
    | 'lastCustomerMessageAt'
    | 'lastAgentMessageAt'
    | 'resolvedAt'
  >,
  now = Date.now(),
): SupportTicket['sla'] {
  const priority = normalizePriority(row.priority);
  const targetMinutes = SUPPORT_FIRST_RESPONSE_TARGET_MINUTES[priority];
  const createdAt = new Date(row.createdAt);
  const responseDueAt = new Date(createdAt.getTime() + targetMinutes * 60_000);
  const firstResponseAt = toNullableIsoString(row.firstResponseAt);

  return {
    targetMinutes,
    responseDueAt: responseDueAt.toISOString(),
    firstResponseAt,
    lastCustomerMessageAt: toNullableIsoString(row.lastCustomerMessageAt),
    lastAgentMessageAt: toNullableIsoString(row.lastAgentMessageAt),
    resolvedAt: toNullableIsoString(row.resolvedAt),
    breached: firstResponseAt === null && now > responseDueAt.getTime(),
  };
}

function normalizeAuthorRole(value: string): MessageAuthorRole {
  if (value === 'customer' || value === 'agent' || value === 'system') {
    return value;
  }
  return 'system';
}

function normalizeTicketContext(input: {
  readonly pageId?: string | null;
  readonly verifySessionId?: string | null;
  readonly pluginServerId?: string | null;
  readonly fileId?: string | null;
}): {
  pageId: string | null;
  verifySessionId: string | null;
  pluginServerId: string | null;
  fileId: string | null;
} {
  return {
    pageId: cleanContextId(input.pageId),
    verifySessionId: cleanContextId(input.verifySessionId),
    pluginServerId: cleanContextId(input.pluginServerId),
    fileId: cleanContextId(input.fileId),
  };
}

function cleanContextId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 64) : null;
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

function toNullableNumber(value: number | bigint | string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableIsoString(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value);
}

function normalizeServerEdition(value: string | null): 'java' | 'bedrock' | null {
  if (value === 'java' || value === 'bedrock') {
    return value;
  }
  return null;
}

function normalizeServerListingStatus(
  value: string | null,
): 'pending' | 'active' | 'suspended' {
  if (value === 'active' || value === 'suspended') {
    return value;
  }
  return 'pending';
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
