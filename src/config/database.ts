import { Pool, PoolConfig, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// مهم: أعمدة DATE (نوع pg 1082) تُرجع كنص خالص YYYY-MM-DD بدل كائن Date يتحول حسب منطقة
// الخادم الزمنية (كان يسبب إزاحة يوماً واحداً في الصيغ المرسلة للواجهة مثل appointment_date/edd_date).
types.setTypeParser(1082, (value: string) => value);

// Connection pool hardening — conservative defaults designed for multi-instance scaling.
// Users ≠ database connections: pool size stays small per instance so that
// multiple API instances never exhaust PostgreSQL max_connections.
//
// Architectural rule:
//   Total application DB connections ≈ API instances × pool max
// Global connection capacity must be coordinated with the actual PostgreSQL
// configuration or an external pooler in future scaling work.
const DEFAULT_POOL_MAX = 10;
const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 10000;
const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_POOL_MAX_LIFETIME_SECONDS = 600;

const RANGES = {
  poolMax: { min: 1, max: 10 },
  connectionTimeoutMs: { min: 1000, max: 60000 },
  idleTimeoutMs: { min: 5000, max: 300000 },
  maxLifetimeSeconds: { min: 60, max: 3600 },
} as const;

// Note: connectionTimeoutMillis bounds pool acquisition / connection acquisition
// behavior but does NOT guarantee an OS-level TCP connect timeout for an unreachable
// database host. If the database host is unreachable, the actual connection failure
// may take longer than this value due to OS TCP retry behavior. This is documented
// here rather than implemented as a separate mechanism; a network/connect-timeout
// investigation can be handled later if evidence shows it is needed.

function readBoundedInt(envKey: string, range: { min: number; max: number }, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return defaultValue;
  const value = parseInt(raw, 10);
  if (Number.isNaN(value) || value < range.min || value > range.max) return defaultValue;
  return value;
}

const poolMax = readBoundedInt('DB_POOL_MAX', RANGES.poolMax, DEFAULT_POOL_MAX);
const connectionTimeoutMillis = readBoundedInt('DB_POOL_CONNECTION_TIMEOUT_MS', RANGES.connectionTimeoutMs, DEFAULT_POOL_CONNECTION_TIMEOUT_MS);
const idleTimeoutMillis = readBoundedInt('DB_POOL_IDLE_TIMEOUT_MS', RANGES.idleTimeoutMs, DEFAULT_POOL_IDLE_TIMEOUT_MS);
const maxLifetimeSeconds = readBoundedInt('DB_POOL_MAX_LIFETIME_SECONDS', RANGES.maxLifetimeSeconds, DEFAULT_POOL_MAX_LIFETIME_SECONDS);

const databaseUrl = process.env.DATABASE_URL;

const poolConfig: PoolConfig = {
  max: poolMax,
  connectionTimeoutMillis,
  idleTimeoutMillis,
  maxLifetimeSeconds,
};

if (databaseUrl) {
  poolConfig.connectionString = databaseUrl;
} else {
  poolConfig.host = process.env.DB_HOST;
  poolConfig.port = Number(process.env.DB_PORT) || 5432;
  poolConfig.user = process.env.DB_USER;
  poolConfig.password = process.env.DB_PASSWORD;
  poolConfig.database = process.env.DB_NAME;
}

export const pool = new Pool(poolConfig);

pool.on('connect', () => {
  console.log('PostgreSQL Database connected successfully');
});

pool.on('error', (err: Error) => {
  console.error('PostgreSQL pool error:', err.message);
});
