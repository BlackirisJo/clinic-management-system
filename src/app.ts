import 'dotenv/config';
import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import authRoutes from './modules/auth/auth.routes';
import patientsRoutes from './modules/patients/patients.routes';
import prescriptionsRoutes from './modules/prescriptions/prescriptions.routes';
import billingRoutes from './modules/billing/billing.routes';
import backupsRoutes from './modules/backups/backups.routes';
import appointmentRoutes from './modules/appointments/appointments.routes';
import usersRoutes from './modules/users/users.routes';
import reportsRoutes from './modules/reports/reports.routes';

const app: Application = express();

// Middlewares للأمان ومعالجة الطلبات
app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:5173').split(',').map((origin) => origin.trim());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const startedAt = Date.now();
  res.on('finish', () => console.log(JSON.stringify({ requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt })));
  next();
});
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));

// فحص سلامة السيرفر (Health Check)
app.get('/health', async (req: Request, res: Response) => {
  try {
    const { pool } = await import('./config/database');
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'OK', message: 'Clinic API is running securely', database: 'OK' });
  } catch {
    res.status(503).json({ status: 'DEGRADED', message: 'Database is unavailable', database: 'ERROR' });
  }
});

// تسجيل مسارات الـ API الرئيسية
app.use('/api/auth', authRoutes);
app.use('/api/patients', patientsRoutes);
app.use('/api/prescriptions', prescriptionsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/reports', reportsRoutes);

// معالجة المسارات غير الموجودة (404 Not Found)
app.use((req: Request, res: Response) => {
  res.status(404).json({ message: 'المسار المطلوب غير موجود على الخادم' });
});

// معالج الأخطاء العام (Global Error Handler)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('❌ Unhandled Server Error:', err.stack || err.message);
  res.status(500).json({
    message: 'حدث خطأ داخلي في الخادم',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

export default app;