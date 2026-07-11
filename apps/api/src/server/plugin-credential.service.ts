import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { encryptAppSecret } from '../common/secret-codec';
import { BusinessEventService } from '../events/business-event.service';

export interface PluginCredentialSummary {
  readonly id: string;
  readonly serverId: string | null;
  readonly guildId: string;
  readonly pluginServerId: string;
  readonly serverName: string;
  readonly host: string;
  readonly port: number;
  readonly endpointUrl: string | null;
  readonly enabled: boolean;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssuedPluginCredential extends PluginCredentialSummary {
  readonly secret: string;
}

@Injectable()
export class PluginCredentialService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly events?: BusinessEventService,
  ) {}

  async list(serverId: string): Promise<PluginCredentialSummary[]> {
    const rows = await this.prisma.pluginServer.findMany({
      where: { serverId },
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map(toSummary);
  }

  async get(serverId: string, credentialId: string): Promise<PluginCredentialSummary> {
    return toSummary(await this.findOwnedCredential(serverId, credentialId));
  }

  async create(
    serverId: string,
    input: { guildId: string; endpointUrl?: string | null },
    actorAccountId: string,
  ): Promise<IssuedPluginCredential> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) {
      throw new NotFoundException('Server was not found.');
    }
    const secret = generateSecret();
    const encryptedSecret = encryptAppSecret(secret);
    if (!encryptedSecret) {
      throw new Error('Failed to encrypt plugin credential.');
    }
    const row = await this.createWithUniqueId({
      serverId,
      guildId: input.guildId,
      serverName: server.name,
      host: server.joinHost,
      port: server.joinPort,
      endpointUrl: input.endpointUrl ?? null,
      serverSecret: encryptedSecret,
    });
    await this.audit('created', row.id, serverId, actorAccountId);
    return { ...toSummary(row), secret };
  }

  async rotate(
    serverId: string,
    credentialId: string,
    actorAccountId: string,
  ): Promise<IssuedPluginCredential> {
    await this.findOwnedCredential(serverId, credentialId);
    const secret = generateSecret();
    const encryptedSecret = encryptAppSecret(secret);
    if (!encryptedSecret) {
      throw new Error('Failed to encrypt plugin credential.');
    }
    const row = await this.prisma.pluginServer.update({
      where: { id: credentialId },
      data: { serverSecret: encryptedSecret },
    });
    await this.audit('rotated', row.id, serverId, actorAccountId);
    return { ...toSummary(row), secret };
  }

  async setEnabled(
    serverId: string,
    credentialId: string,
    enabled: boolean,
    actorAccountId: string,
  ): Promise<PluginCredentialSummary> {
    await this.findOwnedCredential(serverId, credentialId);
    const row = await this.prisma.pluginServer.update({
      where: { id: credentialId },
      data: { enabled },
    });
    await this.audit(enabled ? 'enabled' : 'disabled', row.id, serverId, actorAccountId);
    return toSummary(row);
  }

  private async findOwnedCredential(serverId: string, credentialId: string) {
    const row = await this.prisma.pluginServer.findFirst({
      where: { id: credentialId, serverId },
    });
    if (!row) {
      throw new NotFoundException('Plugin credential was not found.');
    }
    return row;
  }

  private async createWithUniqueId(data: {
    serverId: string;
    guildId: string;
    serverName: string;
    host: string;
    port: number;
    endpointUrl: string | null;
    serverSecret: string;
  }) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.prisma.pluginServer.create({
          data: { ...data, pluginServerId: randomBytes(12).toString('hex') },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }
    }
    throw new Error('Failed to generate a unique plugin server id.');
  }

  private async audit(
    action: 'created' | 'rotated' | 'enabled' | 'disabled',
    credentialId: string,
    serverId: string,
    actorAccountId: string,
  ): Promise<void> {
    await this.events?.audit(`plugin.credential.${action}`, {
      category: 'plugin.sync',
      actorAccountId,
      subjectType: 'plugin_server',
      subjectId: credentialId,
      metadata: { serverId },
    });
  }
}

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

function toSummary(row: {
  id: string;
  serverId: string | null;
  guildId: string;
  pluginServerId: string;
  serverName: string;
  host: string;
  port: number;
  endpointUrl: string | null;
  enabled: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PluginCredentialSummary {
  return {
    id: row.id,
    serverId: row.serverId,
    guildId: row.guildId,
    pluginServerId: row.pluginServerId,
    serverName: row.serverName,
    host: row.host,
    port: row.port,
    endpointUrl: row.endpointUrl,
    enabled: row.enabled,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
