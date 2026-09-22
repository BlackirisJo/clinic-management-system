import 'dotenv/config';
import app from './app';
import { cleanupOldBackups } from './modules/backups/backups.service';

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const sessionCleanup = setInterval(async () => {
  try {
    const { pool } = await import('./config/database');
    await pool.query("DELETE FROM user_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days') OR (revoked_at IS NULL AND expires_at < NOW() - INTERVAL '7 days')");
  } catch (error) {
    console.error('Session cleanup failed:', error);
  }
}, 60 * 60 * 1000);
sessionCleanup.unref();

const backupCleanup = setInterval(() => void cleanupOldBackups().catch((error) => console.error('Backup cleanup failed:', error)), 24 * 60 * 60 * 1000);
backupCleanup.unref();

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    clearInterval(sessionCleanup);
    clearInterval(backupCleanup);
    const { pool } = await import('./config/database');
    await pool.end();
    process.exit(0);
  });
};

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
