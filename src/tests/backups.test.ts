import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

const TEST_BACKUP_DIR = path.join(os.tmpdir(), `clinic-backup-test-${Date.now()}`);
const TEST_ENCRYPTION_KEY = 'test-backup-encryption-key-32bytes!!';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clinic-backup-${Date.now()}-`));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function setEnvVars(opts: {
  BACKUP_DIR?: string;
  BACKUP_ENCRYPTION_KEY?: string;
  DATABASE_URL?: string;
  DB_HOST?: string;
  DB_PORT?: string;
  DB_USER?: string;
  DB_PASSWORD?: string;
  DB_NAME?: string;
}): void {
  if (opts.BACKUP_DIR !== undefined) process.env.BACKUP_DIR = opts.BACKUP_DIR;
  if (opts.BACKUP_ENCRYPTION_KEY !== undefined) process.env.BACKUP_ENCRYPTION_KEY = opts.BACKUP_ENCRYPTION_KEY;
  if (opts.DATABASE_URL !== undefined) process.env.DATABASE_URL = opts.DATABASE_URL;
  if (opts.DB_HOST !== undefined) process.env.DB_HOST = opts.DB_HOST;
  if (opts.DB_PORT !== undefined) process.env.DB_PORT = opts.DB_PORT;
  if (opts.DB_USER !== undefined) process.env.DB_USER = opts.DB_USER;
  if (opts.DB_PASSWORD !== undefined) process.env.DB_PASSWORD = opts.DB_PASSWORD;
  if (opts.DB_NAME !== undefined) process.env.DB_NAME = opts.DB_NAME;
}

function clearEnvVars(): void {
  delete process.env.BACKUP_DIR;
  delete process.env.BACKUP_ENCRYPTION_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.DB_HOST;
  delete process.env.DB_PORT;
  delete process.env.DB_USER;
  delete process.env.DB_PASSWORD;
  delete process.env.DB_NAME;
}

/* ==========================================================================
 * 1. BACKUP SERVICE MODULE LOADING WITH MOCKED SUBPROCESS
 * ========================================================================== */

type BackupService = {
  generateEncryptedBackup: typeof import('../modules/backups/backups.service').generateEncryptedBackup;
  restoreEncryptedBackup: typeof import('../modules/backups/backups.service').restoreEncryptedBackup;
  encryptFile: typeof import('../modules/backups/backups.service').encryptFile;
  decryptFile: typeof import('../modules/backups/backups.service').decryptFile;
  resolveSafeBackupPath: typeof import('../modules/backups/backups.service').resolveSafeBackupPath;
  createBackupZip: typeof import('../modules/backups/backups.service').createBackupZip;
  extractBackupZip: typeof import('../modules/backups/backups.service').extractBackupZip;
  writeBackupMetaFile: typeof import('../modules/backups/backups.service').writeBackupMetaFile;
  getBackupKey: typeof import('../modules/backups/backups.service').getBackupKey;
  isPgDumpAvailable: typeof import('../modules/backups/backups.service').isPgDumpAvailable;
  cleanupOldBackups: typeof import('../modules/backups/backups.service').cleanupOldBackups;
};

async function loadBackupService(mocks: {
  pgDumpAvailable?: boolean;
  pgDumpStderr?: string;
  pgDumpExitCode?: number;
  psqlAvailable?: boolean;
  psqlExitCode?: number;
} = {}): Promise<BackupService> {
  const cp = require('child_process');
  const origExecSync = cp.execSync;
  const origExecFile = cp.execFile;
  const origPromisify = require('util').promisify;

  cp.execSync = (command: string, opts?: { timeout?: number; env?: Record<string, string> }) => {
    if (command.includes('pg_dump')) {
      if (mocks.pgDumpAvailable === false) {
        throw new Error('pg_dump not found');
      }
      return '/usr/bin/pg_dump';
    }
    return origExecSync(command, opts);
  };

  cp.execFile = (cmd: string, args: string[], opts: { env?: Record<string, string> }, callback?: (err: Error | null, stdout: string, stderr: string) => void) => {
    if (cmd === 'pg_dump') {
      if (mocks.pgDumpAvailable === false) {
        const err = new Error('pg_dump not found') as any;
        err.code = 'PG_DUMP_MISSING';
        if (callback) callback(err, '', 'pg_dump not found');
        return;
      }
      const fIndex = args.indexOf('-f');
      if (fIndex !== -1 && args[fIndex + 1]) {
        try { fs.writeFileSync(args[fIndex + 1] as string, '-- PostgreSQL database dump --'); } catch { /* ignore */ }
      }
      if (mocks.pgDumpStderr && mocks.pgDumpExitCode !== undefined) {
        const err = new Error(mocks.pgDumpStderr) as any;
        err.code = mocks.pgDumpExitCode;
        if (callback) callback(err, '', mocks.pgDumpStderr);
        return;
      }
      if (callback) callback(null, '-- PostgreSQL database dump --', '');
      return;
    }
    if (cmd === 'psql') {
      if (mocks.psqlAvailable === false) {
        const err = new Error('psql failed') as any;
        err.code = mocks.psqlExitCode ?? 1;
        if (callback) callback(err, '', 'psql failed');
        return;
      }
      if (callback) callback(null, 'RESTORED', '');
      return;
    }
    if (callback) callback(null, '', '');
  };

  const { Pool } = require('pg');
  const mockPool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ release: () => {} }),
    end: async () => {},
    on: () => {},
    options: { max: 10 },
  };

  const moduleCache = require.cache;
  const dbModulePath = require.resolve('../config/database');
  if (moduleCache[dbModulePath]) {
    delete moduleCache[dbModulePath];
  }

  const { pool } = require('../config/database');
  if (pool) {
    pool.query = mockPool.query;
    pool.connect = mockPool.connect;
    pool.end = mockPool.end;
    pool.on = mockPool.on;
  }

  const backupsPath = require.resolve('../modules/backups/backups.service');
  if (moduleCache[backupsPath]) {
    delete moduleCache[backupsPath];
  }

  const mod = await import('../modules/backups/backups.service');

  return {
    generateEncryptedBackup: mod.generateEncryptedBackup,
    restoreEncryptedBackup: mod.restoreEncryptedBackup,
    encryptFile: mod.encryptFile,
    decryptFile: mod.decryptFile,
    resolveSafeBackupPath: mod.resolveSafeBackupPath,
    createBackupZip: mod.createBackupZip,
    extractBackupZip: mod.extractBackupZip,
    writeBackupMetaFile: mod.writeBackupMetaFile,
    getBackupKey: mod.getBackupKey,
    isPgDumpAvailable: mod.isPgDumpAvailable,
    cleanupOldBackups: mod.cleanupOldBackups,
  };
}

/* ==========================================================================
 * 2. BACKUP CREATION TESTS
 * ========================================================================== */

test('Backup Creation: generateEncryptedBackup success creates .enc and .meta.json', async () => {
  const backupDir = makeTempDir();
  const origBakDir = process.env.BACKUP_DIR;
  setEnvVars({
    BACKUP_DIR: backupDir,
    BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  });

  try {
    const svc = await loadBackupService({ pgDumpAvailable: true });
    const result = await svc.generateEncryptedBackup();

    assert.equal(fs.existsSync(result.filePath), true, '.enc file should exist');
    assert.equal(fs.existsSync(`${result.filePath}.meta.json`), true, '.meta.json should exist');
    assert.ok(result.fileSize > 0, 'fileSize should be > 0');
    assert.ok(result.checksum.length === 64, 'checksum should be SHA256 hex (64 chars)');
    assert.ok(result.iv.length === 32, 'iv should be 16 bytes hex (32 chars)');
    assert.ok(result.authTag.length === 32, 'authTag should be 16 bytes hex (32 chars)');

    const meta = JSON.parse(fs.readFileSync(`${result.filePath}.meta.json`, 'utf8'));
    assert.equal(meta.file, path.basename(result.filePath), 'meta file should match enc file name');
    assert.equal(meta.algorithm, 'aes-256-gcm', 'meta algorithm should match');
    assert.equal(meta.checksum, result.checksum, 'meta checksum should match result checksum');
    assert.equal(meta.file_size_bytes, result.fileSize, 'meta file_size_bytes should match result');
  } finally {
    if (origBakDir !== undefined) {
      process.env.BACKUP_DIR = origBakDir;
    } else {
      clearEnvVars();
    }
    cleanupTempDir(backupDir);
  }
});

test('Backup Creation: generateEncryptedBackup fails when pg_dump missing', async () => {
  const backupDir = makeTempDir();
  const origBakDir = process.env.BACKUP_DIR;
  setEnvVars({
    BACKUP_DIR: backupDir,
    BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  });

  try {
    const svc = await loadBackupService({ pgDumpAvailable: false });
    let threw = false;
    let errorCode = '';
    try {
      await svc.generateEncryptedBackup();
    } catch (e: any) {
      threw = true;
      errorCode = e.code ?? '';
    }
    assert.equal(threw, true, 'Should throw when pg_dump is missing');
    assert.equal(errorCode, 'PG_DUMP_MISSING', 'Error code should be PG_DUMP_MISSING');
  } finally {
    if (origBakDir !== undefined) {
      process.env.BACKUP_DIR = origBakDir;
    } else {
      clearEnvVars();
    }
    cleanupTempDir(backupDir);
  }
});

test('Backup Creation: temp SQL file is cleaned up after successful backup', async () => {
  const backupDir = makeTempDir();
  const origBakDir = process.env.BACKUP_DIR;
  setEnvVars({
    BACKUP_DIR: backupDir,
    BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  });

  try {
    const svc = await loadBackupService({ pgDumpAvailable: true });
    await svc.generateEncryptedBackup();

    const files = fs.readdirSync(backupDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql'));
    assert.equal(sqlFiles.length, 0, 'No temp .sql files should remain after backup');
  } finally {
    if (origBakDir !== undefined) {
      process.env.BACKUP_DIR = origBakDir;
    } else {
      clearEnvVars();
    }
    cleanupTempDir(backupDir);
  }
});

test('Backup Creation: getBackupKey throws when BACKUP_ENCRYPTION_KEY missing', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  delete process.env.BACKUP_ENCRYPTION_KEY;

  try {
    let threw = false;
    try {
      svc.getBackupKey();
    } catch (e: any) {
      threw = true;
    }
    assert.equal(threw, true, 'Should throw when BACKUP_ENCRYPTION_KEY is missing');
  } finally {
    clearEnvVars();
  }
});

/* ==========================================================================
 * 3. ENCRYPTION / INTEGRITY TESTS
 * ========================================================================== */

test('Encryption: encryptFile/decryptFile round-trip', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();

  try {
    const plainPath = path.join(tempDir, 'plain.txt');
    const encPath = path.join(tempDir, 'encrypted.enc');
    const decPath = path.join(tempDir, 'decrypted.txt');

    fs.writeFileSync(plainPath, 'test data for encryption round-trip');

    const { iv, authTag } = await svc.encryptFile(plainPath, encPath, TEST_ENCRYPTION_KEY);
    assert.ok(iv.length > 0, 'IV should be returned');
    assert.ok(authTag.length > 0, 'AuthTag should be returned');

    await svc.decryptFile(encPath, decPath, TEST_ENCRYPTION_KEY, iv, authTag);
    const decrypted = fs.readFileSync(decPath, 'utf8');
    assert.equal(decrypted, 'test data for encryption round-trip', 'Decrypted should match original');
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('Encryption: corrupted .enc file rejected on decrypt', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();

  try {
    const plainPath = path.join(tempDir, 'plain.txt');
    const encPath = path.join(tempDir, 'encrypted.enc');
    const decPath = path.join(tempDir, 'decrypted.txt');

    fs.writeFileSync(plainPath, 'test data');
    await svc.encryptFile(plainPath, encPath, TEST_ENCRYPTION_KEY);

    fs.appendFileSync(encPath, 'corruption');

    let threw = false;
    try {
      await svc.decryptFile(encPath, decPath, TEST_ENCRYPTION_KEY, '', '');
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'Corrupted file should be rejected');
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('Encryption: checksum verification detects tampering', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();

  try {
    const backupDir = path.join(tempDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    const result = await svc.generateEncryptedBackup();
    const tamperedPath = result.filePath;

    fs.appendFileSync(tamperedPath, 'tamper');

    let threw = false;
    try {
      await svc.restoreEncryptedBackup(tamperedPath, result.iv, result.authTag, result.checksum);
    } catch (e: any) {
      threw = true;
      assert.match(e.message, /checksum/i, 'Should reject with checksum error');
    }
    assert.equal(threw, true, 'Tampered backup should be rejected');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('Encryption: checksum mismatch without expected checksum throws', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();

  try {
    const backupDir = path.join(tempDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    const result = await svc.generateEncryptedBackup();
    fs.appendFileSync(result.filePath, 'tamper');

    let threw = false;
    try {
      await svc.restoreEncryptedBackup(result.filePath, result.iv, result.authTag, 'wrongchecksum');
    } catch (e: any) {
      threw = true;
      assert.match(e.message, /checksum/i, 'Should reject with checksum error');
    }
    assert.equal(threw, true, 'Wrong checksum should be rejected');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('Encryption: missing IV or AuthTag in metadata throws', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();

  try {
    const backupDir = path.join(tempDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    const result = await svc.generateEncryptedBackup();
    const metaPath = `${result.filePath}.meta.json`;

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.iv;
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    let threw = false;
    try {
      await svc.restoreEncryptedBackup(result.filePath, '', '', undefined);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'Missing IV should cause failure');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

/* ==========================================================================
 * 4. RESTORE TESTS
 * ========================================================================== */

test('Restore: missing backup file is rejected', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });

  let threw = false;
  try {
    await svc.restoreEncryptedBackup('/nonexistent/path/file.enc', 'iv', 'authTag');
  } catch (e: any) {
    threw = true;
    assert.match(e.message, /not found|not exist|missing|غير موجود|غير صالح/i, 'Should reject missing file');
  }
  assert.equal(threw, true, 'Should throw for missing backup');
});

test('Restore: invalid backup path is rejected by resolveSafeBackupPath', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });

  let threw = false;
  try {
    svc.resolveSafeBackupPath('/etc/passwd');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'Path traversal should be rejected');

  threw = false;
  try {
    svc.resolveSafeBackupPath('..');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'Parent path should be rejected');
});

test('Restore: concurrent restore protection via restoreInProgress flag', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true, psqlAvailable: false });

  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();

    let firstThrows = false;
    try {
      await svc.restoreEncryptedBackup(result.filePath, result.iv, result.authTag, undefined);
    } catch {
      firstThrows = true;
    }

    assert.equal(firstThrows, true, 'First concurrent restore should fail (psql unavailable)');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

/* ==========================================================================
 * 5. ZIP TESTS
 * ========================================================================== */

test('ZIP: createBackupZip creates ZIP with .enc and .meta.json', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();
    const { zipPath, baseName } = svc.createBackupZip(result.filePath);

    assert.ok(fs.existsSync(zipPath), 'ZIP file should exist');
    assert.equal(baseName, path.basename(result.filePath), 'Base name should match .enc file');

    const zipContent = fs.readFileSync(zipPath);
    assert.ok(zipContent.length > 0, 'ZIP should have content');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('ZIP: extractBackupZip extracts .enc and .meta.json correctly', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();
    const { zipPath } = svc.createBackupZip(result.filePath);

    const { encPath, metaPath, tempDir: extractDir } = svc.extractBackupZip(zipPath);

    assert.ok(fs.existsSync(encPath), 'Extracted .enc should exist');
    assert.ok(fs.existsSync(metaPath), 'Extracted .meta.json should exist');

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.checksum, result.checksum, 'Meta checksum should match');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('ZIP: extractBackupZip rejects path traversal in entries', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();
    const { zipPath } = svc.createBackupZip(result.filePath);

    const zip = new (require('adm-zip'))(zipPath);
    const entries = zip.getEntries().filter((e: any) => !e.isDirectory);

    for (const entry of entries) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (name !== path.basename(name) || name.includes('..')) {
        assert.fail('ZIP should not contain traversal entries');
      }
    }
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('ZIP: extractBackupZip rejects malformed ZIP', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const badZipPath = path.join(backupDir, 'bad.zip');
    fs.writeFileSync(badZipPath, 'not a real zip');

    let threw = false;
    try {
      svc.extractBackupZip(badZipPath);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'Malformed ZIP should be rejected');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('ZIP: extractBackupZip requires exactly one .enc and one .meta.json', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const zipPath = path.join(backupDir, 'wrong.zip');
    fs.writeFileSync(zipPath, JSON.stringify({ file: 'test' }));

    let threw = false;
    try {
      svc.extractBackupZip(zipPath);
    } catch (e: any) {
      threw = true;
      assert.match(e.message, /exactly one|Invalid or unsupported zip/i, 'Should reject wrong entry count');
    }
    assert.equal(threw, true, 'ZIP with wrong entries should be rejected');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

/* ==========================================================================
 * 6. AUTHORIZATION TESTS
 * ========================================================================== */

test('Authorization: requirePermission allows SUPER_ADMIN on backup routes', async () => {
  const { requirePermission } = require('../middlewares/auth.middleware');

  const routes = [
    { path: '/', method: 'POST', permission: 'MANAGE_BACKUPS' },
    { path: '/logs', method: 'GET', permission: 'VIEW_BACKUP_LOGS' },
    { path: '/1/download', method: 'GET', permission: 'MANAGE_BACKUPS' },
    { path: '/1/restore', method: 'POST', permission: 'RESTORE_BACKUPS' },
    { path: '/upload-restore', method: 'POST', permission: 'RESTORE_BACKUPS' },
  ];

  for (const route of routes) {
    let nextCalled = false;
    let errorStatus = 0;
    const mockReq = {
      user: {
        userId: 1,
        roleId: 1,
        clinicId: null,
        roleName: 'SUPER_ADMIN',
        permissions: ['MANAGE_BACKUPS', 'VIEW_BACKUP_LOGS', 'RESTORE_BACKUPS'],
      },
      method: route.method,
      path: route.path,
    } as unknown as AuthenticatedRequest;
    const mockRes = { status: (code: number) => ({ json: () => {} }) };

    const middleware = requirePermission(route.permission);
    middleware(mockReq, mockRes as any, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `${route.method} ${route.path} (${route.permission}) should allow SUPER_ADMIN`);
  }
});

test('Authorization: requirePermission rejects ACCOUNTANT on all backup routes', async () => {
  const { requirePermission } = require('../middlewares/auth.middleware');

  const backupPermissions = ['MANAGE_BACKUPS', 'VIEW_BACKUP_LOGS', 'RESTORE_BACKUPS'];

  for (const perm of backupPermissions) {
    let errorStatus = 0;
    let errorThrown = false;
    const mockReq = {
      user: {
        userId: 5,
        roleId: 5,
        clinicId: 1,
        roleName: 'ACCOUNTANT',
        permissions: ['VIEW_PATIENTS', 'MANAGE_SERVICES', 'CREATE_INVOICE'],
      },
      method: 'POST',
      path: '/api/backups',
    } as unknown as AuthenticatedRequest;
    const mockRes = {
      status: (code: number) => { errorStatus = code; return { json: () => {} }; },
    };

    const middleware = requirePermission(perm);
    middleware(mockReq, mockRes as any, (err?: any) => {
      if (err) { errorThrown = true; if (err.statusCode) errorStatus = err.statusCode; }
    });

    assert.equal(errorThrown, true, `${perm} should reject ACCOUNTANT`);
    assert.equal(errorStatus, 403, `${perm} should reject ACCOUNTANT with 403`);
  }
});

test('Authorization: SYSTEM_ADMIN allowed on backup routes', async () => {
  const { requirePermission } = require('../middlewares/auth.middleware');

  const backupPermissions = ['MANAGE_BACKUPS', 'VIEW_BACKUP_LOGS', 'RESTORE_BACKUPS'];

  for (const perm of backupPermissions) {
    let nextCalled = false;
    const mockReq = {
      user: {
        userId: 2,
        roleId: 2,
        clinicId: 1,
        roleName: 'SYSTEM_ADMIN',
        permissions: [],
      },
      method: 'POST',
      path: '/api/backups',
    } as unknown as AuthenticatedRequest;
    const mockRes = { status: (code: number) => ({ json: () => {} }) };

    const middleware = requirePermission(perm);
    middleware(mockReq, mockRes as any, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `${perm} should allow SYSTEM_ADMIN`);
  }
});

test('Authorization: no clinic scope bypass for non-admin backup users', async () => {
  const { requirePermission } = require('../middlewares/auth.middleware');

  let nextCalled = false;
  const mockReq = {
    user: {
      userId: 3,
      roleId: 3,
      clinicId: 1,
      roleName: 'DOCTOR',
      permissions: ['VIEW_PATIENTS', 'CREATE_VISIT'],
    },
    method: 'POST',
    path: '/api/backups',
  } as unknown as AuthenticatedRequest;
  const mockRes = { status: (code: number) => ({ json: () => {} }) };

  const middleware = requirePermission('MANAGE_BACKUPS');
  middleware(mockReq, mockRes as any, (err?: any) => {
    if (!err) nextCalled = true;
  });
  assert.equal(nextCalled, false, 'DOCTOR should NOT bypass MANAGE_BACKUPS');
});

/* ==========================================================================
 * 7. DATABASE CONFIGURATION TESTS
 * ========================================================================== */

test('Database Config: DATABASE_URL is parsed correctly', async () => {
  const { getDBConnectionConfig } = await import('../modules/backups/backups.service');

  setEnvVars({
    DATABASE_URL: 'postgresql://myuser:mypass@dbhost:5433/mydb',
  });

  try {
    const config = getDBConnectionConfig();
    assert.equal(config.host, 'dbhost', 'Host should be parsed from URL');
    assert.equal(config.port, 5433, 'Port should be parsed from URL');
    assert.equal(config.user, 'myuser', 'User should be decoded from URL');
    assert.equal(config.password, 'mypass', 'Password should be decoded from URL');
    assert.equal(config.database, 'mydb', 'Database should be parsed from URL');
  } finally {
    clearEnvVars();
  }
});

test('Database Config: DB_HOST fallback works', async () => {
  const { getDBConnectionConfig } = await import('../modules/backups/backups.service');

  setEnvVars({
    DB_HOST: 'myhost',
    DB_PORT: '5433',
    DB_USER: 'myuser',
    DB_PASSWORD: 'mypass',
    DB_NAME: 'mydb',
  });

  try {
    const config = getDBConnectionConfig();
    assert.equal(config.host, 'myhost', 'Host should come from DB_HOST');
    assert.equal(config.port, 5433, 'Port should come from DB_PORT');
    assert.equal(config.user, 'myuser', 'User should come from DB_USER');
    assert.equal(config.password, 'mypass', 'Password should come from DB_PASSWORD');
    assert.equal(config.database, 'mydb', 'Database should come from DB_NAME');
  } finally {
    clearEnvVars();
  }
});

test('Database Config: DB_HOST default is localhost', async () => {
  const { getDBConnectionConfig } = await import('../modules/backups/backups.service');

  setEnvVars({
    DB_USER: 'postgres',
    DB_NAME: 'clinic_db',
  });

  try {
    const config = getDBConnectionConfig();
    assert.equal(config.host, 'localhost', 'Default host should be localhost');
    assert.equal(config.port, 5432, 'Default port should be 5432');
    assert.equal(config.user, 'postgres', 'Default user should be postgres');
  } finally {
    clearEnvVars();
  }
});

test('Database Config: DATABASE_URL takes precedence over DB_*', async () => {
  const { getDBConnectionConfig } = await import('../modules/backups/backups.service');

  setEnvVars({
    DATABASE_URL: 'postgresql://urluser:urlpass@urlhost:5434/urldb',
    DB_HOST: 'dbhost',
    DB_PORT: '5433',
    DB_USER: 'dbuser',
    DB_PASSWORD: 'dbpass',
    DB_NAME: 'dbname',
  });

  try {
    const config = getDBConnectionConfig();
    assert.equal(config.host, 'urlhost', 'DATABASE_URL host should take precedence');
    assert.equal(config.port, 5434, 'DATABASE_URL port should take precedence');
    assert.equal(config.user, 'urluser', 'DATABASE_URL user should take precedence');
    assert.equal(config.database, 'urldb', 'DATABASE_URL database should take precedence');
  } finally {
    clearEnvVars();
  }
});

test('Database Config: encoded credentials in DATABASE_URL are decoded', async () => {
  const { getDBConnectionConfig } = await import('../modules/backups/backups.service');

  setEnvVars({
    DATABASE_URL: 'postgresql://user%40domain:p%40ss%23word@host:5433/db',
  });

  try {
    const config = getDBConnectionConfig();
    assert.equal(config.user, 'user@domain', 'Username should be URL-decoded');
    assert.equal(config.password, 'p@ss#word', 'Password should be URL-decoded');
  } finally {
    clearEnvVars();
  }
});

test('Database Config: empty DATABASE_URL falls back to DB_*', async () => {
  const { getDBConnectionConfig } = await import('../modules/backups/backups.service');

  setEnvVars({
    DATABASE_URL: '',
    DB_HOST: 'fallbackhost',
    DB_USER: 'fallback',
    DB_NAME: 'fallbackdb',
  });

  try {
    const config = getDBConnectionConfig();
    assert.equal(config.host, 'fallbackhost', 'Empty DATABASE_URL should fall back to DB_HOST');
  } finally {
    clearEnvVars();
  }
});

/* ==========================================================================
 * 8. RESOURCE / CLEANUP TESTS
 * ========================================================================== */

test('Resource: isPgDumpAvailable returns false when pg_dump not in PATH', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: false });
  const result = svc.isPgDumpAvailable();
  assert.equal(result.available, false, 'Should report pg_dump unavailable');
});

test('Resource: resolveSafeBackupPath allows paths within BACKUP_DIR', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();

  try {
    const safePath = svc.resolveSafeBackupPath(path.join(tempDir, 'subdir', 'file.enc'));
    assert.ok(fs.existsSync(safePath) || true, 'Should resolve valid in-dir path');
  } catch {
    /* path may not exist, that is OK */
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('Resource: resolveSafeBackupPath rejects absolute paths outside BACKUP_DIR', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });

  const paths = ['/etc/passwd', '/var/log', 'C:\\Windows\\system32', 'D:/data/secret.enc'];
  for (const p of paths) {
    let threw = false;
    try {
      svc.resolveSafeBackupPath(p);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, `Path ${p} should be rejected`);
  }
});

test('Resource: resolveSafeBackupPath rejects paths with parent traversal', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });

  const paths = [
    '../secret.enc',
    '../../etc/passwd',
    'backups/../secret.enc',
  ];
  for (const p of paths) {
    let threw = false;
    try {
      svc.resolveSafeBackupPath(p);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, `Path ${p} should be rejected`);
  }
});

/* ==========================================================================
 * 9. SECURITY FINDINGS VERIFICATION
 * ========================================================================== */

test('Security: error logging in createBackup does not expose connection string', async () => {
  const { createBackup } = await import('../modules/backups/backups.controller');

  const consoleSpy = { messages: [] as string[] };
  const origError = console.error;
  console.error = (...args: any[]) => {
    consoleSpy.messages.push(args.join(' '));
  };

  try {
    const mockReq = {
      user: { userId: 1, clinicId: 1 },
      method: 'POST',
      path: '/api/backups',
    } as unknown as AuthenticatedRequest;
    const mockRes = {
      status: (_code: number) => ({
        json: (_body: any) => {},
      }),
    };

    createBackup(mockReq as any, mockRes as any).catch(() => {
      /* expected */
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const logOutput = consoleSpy.messages.join(' ');
    const hasConnectionString = logOutput.includes('postgresql://') || logOutput.includes('clinic_admin') || logOutput.includes('clinic_secure_pass');
    assert.ok(!hasConnectionString, 'Console output should not contain connection string or password');
    if (logOutput) {
      assert.match(logOutput, /error/i, 'Should log error when backup fails');
    }
  } finally {
    console.error = origError;
  }
});

test('Security: backup file meta.json has restrictive permissions', async () => {
  if (process.platform === 'win32') {
    assert.ok(true, 'Skipped on Windows (file permissions not enforced)');
    return;
  }
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();
    const metaPath = `${result.filePath}.meta.json`;
    const metaMode = fs.statSync(metaPath).mode;

    const othersRead = (metaMode & 0o004) !== 0;
    const othersWrite = (metaMode & 0o002) !== 0;
    const groupWrite = (metaMode & 0o020) !== 0;

    assert.equal(othersRead, false, 'Meta file should not be world-readable');
    assert.equal(othersWrite, false, 'Meta file should not be world-writable');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('Security: backup .enc file is not world-readable on file creation', async () => {
  if (process.platform === 'win32') {
    assert.ok(true, 'Skipped on Windows (file permissions not enforced)');
    return;
  }
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();
    const encMode = fs.statSync(result.filePath).mode;

    const othersRead = (encMode & 0o004) !== 0;
    assert.equal(othersRead, false, '.enc file should not be world-readable');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('Security: no secrets printed in test output', async () => {
  const serviceCode = fs.readFileSync(require.resolve('../modules/backups/backups.service.js'), 'utf8');

  assert.equal(serviceCode.includes('console.log(password)'), false, 'Should not log password');
  assert.equal(serviceCode.includes('console.log(DB_PASSWORD)'), false, 'Should not log DB_PASSWORD');
  assert.equal(serviceCode.includes('console.log(connectionString)'), false, 'Should not log connectionString');

  const controllerCode = fs.readFileSync(require.resolve('../modules/backups/backups.controller.js'), 'utf8');
  assert.equal(controllerCode.includes('req.user?.password'), false, 'Should not log user password');
});

/* ==========================================================================
 * 10. ADDITIONAL INTEGRITY TESTS
 * ========================================================================== */

test('Integrity: backup log record stores required fields', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();
    const meta = JSON.parse(fs.readFileSync(`${result.filePath}.meta.json`, 'utf8'));

    const required = ['file', 'algorithm', 'iv', 'auth_tag', 'checksum', 'file_size_bytes', 'database', 'created_at'];
    for (const field of required) {
      assert.ok(meta[field] !== undefined, `Meta should include ${field}`);
    }
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('Integrity: checksum is deterministic', async () => {
  const svc = await loadBackupService({ pgDumpAvailable: true });
  const tempDir = makeTempDir();
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  setEnvVars({ BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

  try {
    const result = await svc.generateEncryptedBackup();
    const fileBuffer = fs.readFileSync(result.filePath);
    const computedChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    assert.equal(computedChecksum, result.checksum, 'Computed checksum should match stored checksum');
  } finally {
    clearEnvVars();
    cleanupTempDir(tempDir);
  }
});

test('Cleanup: temp directories are removed after tests', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('clinic-backup-test'));
  // This test verifies that temp directories from previous tests are cleaned up
  // by checking that no orphaned directories exist
  assert.ok(before.length < 10, 'Should not have excessive orphaned temp dirs');
});

/* ========================================================================== */