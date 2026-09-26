import { exec, execSync, execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import util from 'util';
import AdmZip from 'adm-zip';
import { pool } from '../../config/database';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

export const getDBConnectionConfig = (): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 5432,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password || ''),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'clinic_db',
  };
};

export const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const ALGORITHM = 'aes-256-gcm';

// Ensures a path stays inside BACKUP_DIR (path traversal protection) and
// returns its absolute form. Throws when the path escapes the backup dir.
export const resolveSafeBackupPath = (filePath: string): string => {
  const backupRoot = path.resolve(BACKUP_DIR);
  const resolved = path.resolve(filePath);
  const relative = path.relative(backupRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('مسار ملف النسخة الاحتياطية غير صالح');
  }
  return resolved;
};
let restoreInProgress = false;

export const getBackupKey = (): string => {
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    throw new Error('BACKUP_ENCRYPTION_KEY is required');
  }
  return process.env.BACKUP_ENCRYPTION_KEY;
};

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export const cleanupOldBackups = async (): Promise<void> => {
  const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 30);
  const result = await pool.query(
    `SELECT backup_id, file_path FROM backup_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [retentionDays]
  );
  for (const backup of result.rows) {
    let safePath: string;
    try {
      safePath = resolveSafeBackupPath(backup.file_path);
    } catch {
      // Path outside the backup directory - never touch files outside scope
      await pool.query('DELETE FROM backup_logs WHERE backup_id = $1', [backup.backup_id]);
      continue;
    }
    if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
    // حذف ملف الوصف الجانبي المرافق إن وجد
    const metaPath = `${safePath}.meta.json`;
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    await pool.query('DELETE FROM backup_logs WHERE backup_id = $1', [backup.backup_id]);
  }
};

// 1. تشفير الملف بـ AES-256-GCM
export const encryptFile = (
  inputPath: string,
  outputPath: string,
  secretKey: string
): Promise<{ iv: string; authTag: string }> => {
  return new Promise((resolve, reject) => {
    const key = crypto.scryptSync(secretKey, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath);

    input.pipe(cipher).pipe(output);

    output.on('finish', () => {
      const authTag = cipher.getAuthTag().toString('hex');
      resolve({
        iv: iv.toString('hex'),
        authTag,
      });
    });

    output.on('error', (err) => reject(err));
    input.on('error', (err) => reject(err));
    cipher.on('error', (err) => reject(err));
  });
};

// 2. فك تشفير الملف بـ AES-256-GCM
export const decryptFile = (
  inputPath: string,
  outputPath: string,
  secretKey: string,
  ivHex: string,
  authTagHex: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const key = crypto.scryptSync(secretKey, 'salt', 32);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath);

    input.pipe(decipher).pipe(output);

    output.on('finish', () => resolve());
    output.on('error', (err) => reject(err));
    input.on('error', (err) => reject(err));
    decipher.on('error', (err) => reject(err));
  });
};

// 3.1 كتابة ملف وصف جانبي بجانب النسخة المشفرة حتى تبقى قابلة للاسترجاع
// حتى في سيناريو فقدان قاعدة البيانات بالكامل (لا يعتمد فك التشفير على backup_logs فقط).
// iv و auth_tag ليسا سريين (GCM) — السر هو BACKUP_ENCRYPTION_KEY في متغيرات البيئة فقط.
export const writeBackupMetaFile = (
  encryptedPath: string,
  meta: Record<string, unknown>
): void => {
  fs.writeFileSync(`${encryptedPath}.meta.json`, JSON.stringify(meta, null, 2), { mode: 0o600 });
};

// 3. إنتاج نسخة احتياطية مشفرة
export const isPgDumpAvailable = (): { available: boolean; path?: string; error?: string } => {
  try {
    const result = execSync('command -v pg_dump 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000, env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD } }).trim();
    if (result) {
      return { available: true, path: result };
    }
    return { available: false, error: 'pg_dump not found in PATH' };
  } catch (e) {
    return { available: false, error: (e as Error).message };
  }
};

export const generateEncryptedBackup = async (): Promise<{
  filePath: string;
  fileSize: number;
  checksum: string;
  iv: string;
  authTag: string;
}> => {
  const pgDumpCheck = isPgDumpAvailable();
  if (!pgDumpCheck.available) {
    throw Object.assign(new Error('pg_dump not found — PostgreSQL client not installed'), { code: 'PG_DUMP_MISSING', pgDumpCheck });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempSqlPath = path.join(BACKUP_DIR, `dump_${timestamp}.sql`);
  const encryptedPath = path.join(BACKUP_DIR, `backup_${timestamp}.enc`);

  const encryptionKey = getBackupKey();

  const { host: dbHost, port: dbPort, user: dbUser, password: dbPassword, database: dbName } = getDBConnectionConfig();

  await execFilePromise('pg_dump', [
    '-h', dbHost,
    '-p', String(dbPort),
    '-U', dbUser,
    '-F', 'p',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '-d', dbName,
    '-f', tempSqlPath,
  ], {
    env: { ...process.env, PGPASSWORD: dbPassword },
  });

  const { iv, authTag } = await encryptFile(tempSqlPath, encryptedPath, encryptionKey);

  if (fs.existsSync(tempSqlPath)) {
    fs.unlinkSync(tempSqlPath);
  }

  const fileBuffer = fs.readFileSync(encryptedPath);
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const stats = fs.statSync(encryptedPath);

  // وصف جانبي ذاتي الكفاية لكل نسخة (استرجاع الكوارث من الملفات وحدها)
  writeBackupMetaFile(encryptedPath, {
    file: path.basename(encryptedPath),
    algorithm: ALGORITHM,
    iv,
    auth_tag: authTag,
    checksum,
    file_size_bytes: stats.size,
    database: dbName,
    created_at: new Date().toISOString(),
  });

  return {
    filePath: encryptedPath,
    fileSize: stats.size,
    checksum,
    iv,
    authTag,
  };
};

// 4. استرجاع قاعدة البيانات من الملف
export const restoreEncryptedBackup = async (
  encryptedFilePath: string,
  ivHex: string,
  authTagHex: string,
  expectedChecksum?: string
): Promise<void> => {
  const safeFilePath = resolveSafeBackupPath(encryptedFilePath);
  if (!fs.existsSync(safeFilePath)) {
    throw new Error('ملف النسخة الاحتياطية غير موجود');
  }
  if (restoreInProgress) throw new Error('A backup restore is already in progress');
  if (expectedChecksum) {
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(safeFilePath)).digest('hex');
    if (checksum !== expectedChecksum) throw new Error('Backup checksum verification failed');
  }
  restoreInProgress = true;

  const timestamp = Date.now();
  const tempSqlPath = path.join(BACKUP_DIR, `restore_temp_${timestamp}.sql`);
  const encryptionKey = getBackupKey();

  const { host: dbHost, port: dbPort, user: dbUser, password: dbPassword, database: dbName } = getDBConnectionConfig();

  try {
    await decryptFile(safeFilePath, tempSqlPath, encryptionKey, ivHex, authTagHex);

    await execFilePromise('psql', [
      '--set=ON_ERROR_STOP=1',
      '--single-transaction',
      '-h', dbHost,
      '-p', String(dbPort),
      '-U', dbUser,
      '-d', dbName,
      '-f', tempSqlPath,
    ], {
      env: { ...process.env, PGPASSWORD: dbPassword },
    });
  } finally {
    if (fs.existsSync(tempSqlPath)) {
      fs.unlinkSync(tempSqlPath);
    }
    restoreInProgress = false;
  }
};

// 6. إنشاء ملف ZIP يحتوي على .enc و .meta.json للتنزيل
export const createBackupZip = (encPath: string): { zipPath: string; baseName: string } => {
  const safeEncPath = resolveSafeBackupPath(encPath);
  const metaPath = `${safeEncPath}.meta.json`;

  if (!fs.existsSync(safeEncPath)) throw new Error('Backup file not found');
  if (!fs.existsSync(metaPath)) throw new Error('Backup metadata not found');

  const baseName = path.basename(safeEncPath);
  const zipPath = path.join(BACKUP_DIR, `backup_${Date.now()}.zip`);

  const zip = new AdmZip();
  zip.addLocalFile(safeEncPath);
  zip.addLocalFile(metaPath);
  zip.writeZip(zipPath);

  return { zipPath, baseName };
};

// 7. استخراج ملف ZIP واسترجاع المسارات
export const extractBackupZip = (zipPath: string): { encPath: string; metaPath: string; tempDir: string } => {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  if (entries.length !== 2) throw new Error('ZIP must contain exactly one .enc and one .meta.json');

  const encEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.enc'));
  const metaEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.meta.json'));

  if (!encEntry || !metaEntry) throw new Error('ZIP must contain exactly one .enc and one .meta.json');

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (name !== path.basename(name) || name.includes('..')) {
      throw new Error('Invalid file path in ZIP');
    }
  }

  const tempDir = path.join(BACKUP_DIR, `restore_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  zip.extractAllTo(tempDir, false);

  const encPath = path.join(tempDir, path.basename(encEntry.entryName));
  const metaPath = path.join(tempDir, path.basename(metaEntry.entryName));

  if (!fs.existsSync(encPath) || !fs.existsSync(metaPath)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error('Missing expected files in ZIP');
  }

  return { encPath, metaPath, tempDir };
};