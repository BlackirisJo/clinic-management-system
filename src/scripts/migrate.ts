import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../config/database';

const migrationsDir = path.join(__dirname, '../../src/database/migrations');

const migrate = async (): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    const hasExistingSchema = (await client.query("SELECT to_regclass('public.roles') IS NOT NULL AS exists")).rows[0].exists;
    if (hasExistingSchema) {
      await client.query(`INSERT INTO schema_migrations (version) VALUES
        ('001_initial_schema.sql'), ('002_update_backups_schema.sql')
        ON CONFLICT DO NOTHING`);
    }

    const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (applied.rowCount) continue;

      await client.query('BEGIN');
      try {
        await client.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied migration: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
};

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});