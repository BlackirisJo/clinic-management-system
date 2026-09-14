import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { generateEncryptedBackup, restoreEncryptedBackup, resolveSafeBackupPath } from './backups.service';

const createSafetyBackup = async (userId: number | undefined) => {
  const backup = await generateEncryptedBackup();
  await pool.query(
    `INSERT INTO backup_logs (file_path, file_size_bytes, checksum, iv, auth_tag, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6)`,
    [backup.filePath, backup.fileSize, backup.checksum, backup.iv, backup.authTag, userId ?? null]
  );
};

// 1. إنشاء نسخة احتياطية
export const createBackup = async (req: AuthenticatedRequest, res: Response) => {
  const createdByUserId = req.user?.userId;

  try {
    const { filePath, fileSize, checksum, iv, authTag } = await generateEncryptedBackup();

    const result = await pool.query(
      `INSERT INTO backup_logs (file_path, file_size_bytes, checksum, iv, auth_tag, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING backup_id, file_size_bytes, checksum, status, created_at`,
      [filePath, fileSize, checksum, iv, authTag, 'SUCCESS', createdByUserId || null]
    );

    return res.status(201).json({
      message: 'تم إنشاء النسخة الاحتياطية المشفرة بنجاح',
      backup: result.rows[0],
    });
  } catch (error: any) {
    console.error('Create Backup Error:', error);
    // فشل أوامر pg_dump/psql بسبب غياب PostgreSQL client على المضيف يُعاد كـ 503
    // برسالة واضحة بدلاً من 500 عام (البيئة المزروعة بـ Docker تتضمن postgresql-client).
    const stderr: string = error?.stderr || '';
    if (error?.code === 'ENOENT' || /pg_dump|psql.*(not recognized|not found)/i.test(stderr) || /ENOENT/i.test(error?.message || '')) {
      return res.status(503).json({
        message: 'خدمة النسخ الاحتياطي غير متاحة: pg_dump غير مثبت على الخادم. ثبّت postgresql-client أو استخدم نشر Docker.',
      });
    }
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء النسخة الاحتياطية' });
  }
};

// 2. عرض قائمة سجلات النسخ الاحتياطية
export const getBackupLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const result = await pool.query(
      `SELECT b.backup_id, b.file_size_bytes, b.checksum, b.status, b.created_at,
              u.full_name AS created_by_user
       FROM backup_logs b
       LEFT JOIN users u ON b.created_by_user_id = u.user_id
       ORDER BY b.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]
    );

     return res.status(200).json({ backups: result.rows, pagination: { page, limit, returned: result.rows.length } });
  } catch (error) {
    console.error('Get Backup Logs Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب السجلات' });
  }
};

// 3. تنزيل ملف النسخة الاحتياطية المشفر للكمبيوتر الشخصي
export const downloadBackup = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const backupQuery = await pool.query(
      `SELECT file_path FROM backup_logs WHERE backup_id = $1 AND status = 'SUCCESS'`,
      [id]
    );

    if (backupQuery.rows.length === 0) {
      return res.status(404).json({ message: 'ملف النسخة الاحتياطية غير موجود' });
    }

    let filePath: string;
    try {
      filePath = resolveSafeBackupPath(backupQuery.rows[0].file_path);
    } catch (error) {
      return res.status(400).json({ message: (error as Error).message });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'الملف غير موجود على السيرفر' });
    }

    const fileName = path.basename(filePath);
    return res.download(filePath, fileName);
  } catch (error) {
    console.error('Download Backup Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تحميل الملف' });
  }
};

// 4. استرجاع نسخة مسبقة مخزنة على السيرفر
export const restoreBackup = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const backupQuery = await pool.query(
      `SELECT file_path, iv, auth_tag, checksum, status FROM backup_logs WHERE backup_id = $1`,
      [id]
    );

    if (backupQuery.rows.length === 0) {
      return res.status(404).json({ message: 'سجل النسخة الاحتياطية غير موجود' });
    }

    const backup = backupQuery.rows[0];

    if (backup.status !== 'SUCCESS') {
      return res.status(400).json({ message: 'لا يمكن استرجاع نسخة فاشلة' });
    }

    await createSafetyBackup(req.user?.userId);
    await restoreEncryptedBackup(backup.file_path, backup.iv, backup.auth_tag, backup.checksum);
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'BACKUP_RESTORED', 'BACKUP', $3)`,
      [req.user?.userId, req.user?.clinicId, id]
    );

    return res.status(200).json({
      message: 'تم استرجاع قاعدة البيانات بنجاح',
    });
  } catch (error: any) {
    console.error('Restore Backup Error:', error);
    return res.status(500).json({ message: error.message || 'حدث خطأ أثناء استرجاع النسخة' });
  }
};

// 5. رفع ملف نسخة احتياطية خارجي واسترجاعه يدوياً
export const uploadAndRestoreBackup = async (req: AuthenticatedRequest, res: Response) => {
  const file = req.file;
  const { iv, auth_tag } = req.body;

  if (!file) {
    return res.status(400).json({ message: 'يرجى رفع ملف النسخة الاحتياطية (.enc)' });
  }

  if (!iv || !auth_tag) {
    // حذف الملف المرفوع إذا كانت المدخلات ناقصة
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ message: 'قيم التشفير (iv) و (auth_tag) مطلوبة لفك تشفير الملف' });
  }

  try {
    await createSafetyBackup(req.user?.userId);
    await restoreEncryptedBackup(file.path, iv, auth_tag);
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type)
       VALUES ($1, $2, 'UPLOADED_BACKUP_RESTORED', 'BACKUP')`,
      [req.user?.userId, req.user?.clinicId]
    );

    return res.status(200).json({
      message: 'تم استرجاع قاعدة البيانات من الملف المرفوع بنجاح',
    });
  } catch (error: any) {
    console.error('Upload & Restore Error:', error);
    return res.status(500).json({ message: error.message || 'فشل فك تشفير أو استرجاع الملف المرفوع' });
  } finally {
    // إزالة الملف المرفوع المؤقت للحفاظ على النظافة والأمان
    if (file && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
};