import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from '../wiki/wiki-permission.service';

export interface FilePermissionSubject {
  readonly ownerAccountId: string | null;
  readonly visibility?: string | null;
  readonly status: string;
  readonly linkedResourceType?: string | null;
  readonly linkedResourceId?: string | null;
}

export interface LinkedFileResource {
  readonly type: 'wiki_page' | 'wiki_space';
  readonly id: string;
}

export type FileReadDecision = 'allow' | 'linked' | 'deny' | 'missing';

export function fileReadDecision(
  file: FilePermissionSubject | null,
  identity?: { readonly accountId?: string | null; readonly permissions?: readonly string[] }
): FileReadDecision {
  if (!file || file.status === 'deleted') return 'missing';
  if (file.visibility === 'public' || file.visibility === 'unlisted' || !file.visibility) return 'allow';
  if (identity?.permissions?.includes('file.admin') === true || (identity?.accountId && file.ownerAccountId === identity.accountId)) return 'allow';
  return file.visibility === 'restricted' ? 'linked' : 'deny';
}

@Injectable()
export class FilePermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService
  ) {}

  async assertCanRead(
    file: FilePermissionSubject | null,
    session?: SessionPayload | null
  ): Promise<void> {
    const decision = fileReadDecision(file, {
      accountId: session?.userId,
      permissions: session?.permissions
    });
    if (decision === 'allow') return;
    if (decision === 'linked' && file) {
      await this.assertCanReadLinkedResource(file, session);
      return;
    }
    throw new NotFoundException('File not found.');
  }

  async assertCanLink(resource: LinkedFileResource, session: SessionPayload): Promise<void> {
    const actorBase = await this.wikiPermissions.resolveActor(session.userId);
    if (!actorBase) {
      throw new ForbiddenException('Wiki profile is required for linked uploads.');
    }
    const actor = {
      ...actorBase,
      isElevated: session.isElevated,
      permissions: session.permissions,
      groups: session.groups
    };
    if (resource.type === 'wiki_page') {
      const page = await this.prisma.wikiPage.findUnique({ where: { id: BigInt(resource.id) } });
      await this.wikiPermissions.assertCanEditPage({ actor, page });
      await this.wikiPermissions.assertCanUsePageAction({
        accountId: session.userId,
        action: 'upload_file',
        page
      });
      return;
    }
    const space = await this.prisma.wikiSpace.findUnique({ where: { id: BigInt(resource.id) } });
    if (!space || space.status !== 'active') {
      throw new NotFoundException('Wiki space not found.');
    }
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: space.rootNamespaceCode }
    });
    const syntheticPage = {
      id: 0n,
      namespaceId: namespace?.id,
      spaceId: space.id,
      title: space.title,
      protectionLevel: 'open',
      status: 'normal',
      createdBy: space.createdBy
    };
    await this.wikiPermissions.assertCanEditPage({ actor, page: syntheticPage });
    await this.wikiPermissions.assertCanUsePageAction({
      accountId: session.userId,
      action: 'upload_file',
      page: syntheticPage
    });
  }

  assertCanDelete(file: FilePermissionSubject | null, session: SessionPayload): asserts file is FilePermissionSubject {
    if (!file || file.status === 'deleted') {
      throw new NotFoundException('File not found.');
    }
    if (this.isOwnerOrAdmin(file, session)) {
      return;
    }
    throw new ForbiddenException('File owner is required.');
  }

  private isOwnerOrAdmin(file: FilePermissionSubject, session?: SessionPayload | null): boolean {
    return Boolean(
      session &&
        (session.permissions?.includes('file.admin') === true ||
          file.ownerAccountId === session.userId),
    );
  }

  private async assertCanReadLinkedResource(
    file: FilePermissionSubject,
    session?: SessionPayload | null
  ): Promise<void> {
    const id = file.linkedResourceId?.trim();
    if (!id || !/^\d+$/.test(id)) {
      throw new NotFoundException('File not found.');
    }
    const actorBase = session ? await this.wikiPermissions.resolveActor(session.userId) : null;
    const actor = actorBase && session ? {
      ...actorBase,
      isElevated: session.isElevated,
      permissions: session.permissions,
      groups: session.groups,
      requestIp: session.requestIp
    } : null;
    if (file.linkedResourceType === 'wiki_page') {
      const page = await this.prisma.wikiPage.findUnique({ where: { id: BigInt(id) } });
      await this.wikiPermissions.assertCanReadPage({
        accountId: session?.userId ?? null,
        actor,
        requestIp: session?.requestIp,
        page
      });
      return;
    }
    if (file.linkedResourceType === 'wiki_space') {
      await this.wikiPermissions.assertCanReadSpace({
        accountId: session?.userId ?? null,
        actor,
        requestIp: session?.requestIp,
        spaceId: BigInt(id)
      });
      return;
    }
    throw new NotFoundException('File not found.');
  }
}
