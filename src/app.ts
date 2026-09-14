import 'dotenv/config';
import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { randomUUID } from 'crypto';
import authRoutes from './modules/auth/auth.routes';
import patientsRoutes from './modules/patients/patients.routes';
import prescriptionsRoutes from './modules/prescriptions/prescriptions.routes';
import billingRoutes from './modules/billing/billing.routes';
import backupsRoutes from './modules/backups/backups.routes';
import appointmentRoutes from './modules/appointments/appointments.routes';
import usersRoutes from './modules/users/users.routes';
import reportsRoutes from './modules/reports/reports.routes';
import clinicsRoutes from './modules/clinics/clinics.routes';
import medicationImportRoutes from './modules/prescriptions/medication.import.routes';
import clinicalRoutes from './modules/clinical/clinical.routes';
import permissionsRoutes from './modules/permissions/permissions.routes';

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
app.use('/api/clinics', clinicsRoutes);
app.use('/api/medications/import', medicationImportRoutes);
app.use('/api/clinical', clinicalRoutes);
app.use('/api/permissions', permissionsRoutes);

// معالجة المسارات غير الموجودة (404 Not Found)
app.use((req: Request, res: Response) => {
  res.status(404).json({ message: 'المسار المطلوب غير موجود على الخادم' });
});

// معالج الأخطاء العام (Global Error Handler)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  // أخطاء رفع الملفات (Multer أو فلتر types) هي أخطاء من العميل — 400 وليس 500
  if (err instanceof multer.MulterError || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: err.message || 'حجم الملف يتجاوز الحد المسموح' });
  }
  if (typeof err?.message === 'string' && (err.message.includes('CSV') || err.message.includes('غير مسموح'))) {
    return res.status(400).json({ message: err.message });
  }
  console.error('❌ Unhandled Server Error:', err.stack || err.message);
  res.status(500).json({
    message: 'حدث خطأ داخلي في الخادم',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

export default app;