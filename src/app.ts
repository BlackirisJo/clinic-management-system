import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRoutes from './modules/auth/auth.routes';
import patientsRoutes from './modules/patients/patients.routes';
import prescriptionsRoutes from './modules/prescriptions/prescriptions.routes';
import billingRoutes from './modules/billing/billing.routes';
import backupsRoutes from './modules/backups/backups.routes';
import appointmentRoutes from './modules/appointments/appointments.routes';

dotenv.config();

const app: Application = express();

// Middlewares للأمان ومعالجة الطلبات
app.use(helmet());
app.use(cors());
app.use(express.json());

// فحص سلامة السيرفر (Health Check)
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', message: 'Clinic API is running securely' });
});

// تسجيل مسارات الـ API الرئيسية
app.use('/api/auth', authRoutes);
app.use('/api/patients', patientsRoutes);
app.use('/api/prescriptions', prescriptionsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/appointments', appointmentRoutes);

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