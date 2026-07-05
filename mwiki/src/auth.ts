import type { FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { exec, one, query } from './db.js';

export interface CurrentUser {
  id: number;
  username: string;
  display_name: string;
  groups: string[];
  permissions: string[];
}

export async function login(email: string, password: string) {
  const user = await one<any>(`SELECT id, password_hash FROM users WHERE email=:email AND status='active'`, { email: String(email ?? '').trim().toLowerCase() });
  if (!user?.password_hash) return null;
  if (!(await bcrypt.compare(password, user.password_hash))) return null;
  return getUser(Number(user.id));
}

export async function getUser(id: number): Promise<CurrentUser | null> {
  const user = await one<any>(`SELECT id, username, display_name FROM users WHERE id=:id AND status='active'`, { id });
  if (!user) return null;
  const groups = await query<any>(
    `SELECT g.code FROM user_groups ug JOIN groups g ON g.id=ug.group_id WHERE ug.user_id=:id`,
    { id }
  );
  const permissions = await query<any>(
    `SELECT gp.permission_code FROM user_groups ug
     JOIN group_permissions gp ON gp.group_id=ug.group_id
     WHERE ug.user_id=:id`,
    { id }
  );
  return {
    id: Number(user.id),
    username: user.username,
    display_name: user.display_name,
    groups: groups.map((row) => row.code),
    permissions: permissions.map((row) => row.permission_code)
  };
}

export async function currentUser(request: FastifyRequest) {
  const raw = request.cookies?.uid;
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value || !/^\d+$/.test(unsigned.value)) return null;
  return getUser(Number(unsigned.value));
}

export function can(user: CurrentUser | null, permission: string) {
  return Boolean(user?.permissions.includes(permission) || user?.groups.includes('developer'));
}

export async function blockUser(userId: number, actorId: number | null, reason = '관리자 차단', expiresAt: string | null = null) {
  await exec(`UPDATE users SET status='blocked', updated_at=NOW() WHERE id=:userId`, { userId });
  await exec(
    `INSERT INTO user_blocks (user_id, blocked_by, reason, expires_at, created_at)
     VALUES (:userId, :actorId, :reason, :expiresAt, NOW())`,
    { actorId: actorId ?? 0, userId, reason, expiresAt }
  );
  await exec(
    `INSERT INTO admin_logs (actor_id, action, target_type, target_id, details, created_at)
     VALUES (:actorId, 'user.block', 'user', :userId, :details, NOW())`,
    { actorId, userId, details: JSON.stringify({ reason, expiresAt }) }
  );
}

export async function unblockUser(userId: number, actorId: number | null, reason = '관리자 차단 해제') {
  await exec(`UPDATE users SET status='active', updated_at=NOW() WHERE id=:userId`, { userId });
  await exec(`UPDATE user_blocks SET revoked_at=NOW(), revoked_by=:actorId WHERE user_id=:userId AND revoked_at IS NULL`, { actorId, userId });
  await exec(
    `INSERT INTO admin_logs (actor_id, action, target_type, target_id, details, created_at)
     VALUES (:actorId, 'user.unblock', 'user', :userId, :details, NOW())`,
    { actorId, userId, details: JSON.stringify({ reason }) }
  );
}
