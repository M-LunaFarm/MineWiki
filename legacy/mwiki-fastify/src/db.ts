import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  timezone: '+09:00',
  charset: 'utf8mb4'
});

export async function query<T = any>(sql: string, params: Record<string, unknown> | unknown[] = {}) {
  const [rows] = await pool.query(sql, params as any);
  return rows as T[];
}

export async function one<T = any>(sql: string, params: Record<string, unknown> | unknown[] = {}) {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: Record<string, unknown> | unknown[] = {}) {
  const [result] = await pool.execute(sql, params as any);
  return result as mysql.ResultSetHeader;
}

export async function tx<T>(fn: (conn: mysql.PoolConnection) => Promise<T>) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const value = await fn(conn);
    await conn.commit();
    return value;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
