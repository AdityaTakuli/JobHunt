import mysql from 'mysql2/promise';
import { config } from '../config.js';

let pool;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.db,
      // Store and read every DATETIME as UTC; the UI converts to IST.
      timezone: 'Z',
      charset: 'utf8mb4',
      connectionLimit: 5,
      waitForConnections: true,
      enableKeepAlive: true,
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// MySQL returns JSON columns as objects, MariaDB (Hostinger) returns strings.
export function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
