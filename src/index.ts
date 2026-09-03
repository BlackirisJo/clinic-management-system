import 'dotenv/config';
import app from './app';

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    const { pool } = await import('./config/database');
    await pool.end();
    process.exit(0);
  });
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));