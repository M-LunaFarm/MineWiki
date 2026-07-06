import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { SessionPayload } from '../session/session.service';

export interface FilePermissionSubject {
  readonly ownerAccountId: string | null;
  readonly visibility?: string | null;
  readonly status: string;
}

@Injectable()
export class FilePermissionService {
  assertCanRead(file: FilePermissionSubject | null, session?: SessionPayload | null): asserts file is FilePermissionSubject {
    if (!file || file.status === 'deleted') {
      throw new NotFoundException('File not found.');
    }
    if (file.visibility === 'public' || file.visibility === 'unlisted' || !file.visibility) {
      return;
    }
    if (this.isOwnerOrAdmin(file, session)) {
      return;
    }
    throw new NotFoundException('File not found.');
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
    return Boolean(session && (session.isElevated || file.ownerAccountId === session.userId));
  }
}
