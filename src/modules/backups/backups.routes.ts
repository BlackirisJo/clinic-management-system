import { Router } from 'express';
import multer from 'multer';
import {
  createBackup,
  getBackupLogs,
  downloadBackup,
  restoreBackup,
  uploadAndRestoreBackup,
} from './backups.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';

const upload = multer({
  dest: 'backups/temp_uploads/',
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    callback(null, ext === 'enc' || ext === 'zip');
  },
});
const router = Router();

router.use(authenticateJWT);

// 1. إنتاج نسخة جديدة
router.post('/', requirePermission('MANAGE_BACKUPS'), createBackup);

// 2. عرض السجلات
router.get('/logs', requirePermission('VIEW_BACKUP_LOGS'), getBackupLogs);

// 3. تنزيل نسخة للكمبيوتر
router.get('/:id/download', requirePermission('MANAGE_BACKUPS'), downloadBackup);

// 4. استرجاع نسخة من السجلات التلقائية
router.post('/:id/restore', requirePermission('RESTORE_BACKUPS'), restoreBackup);

// 5. رفع ملف خارجي واسترجاعه
router.post(
  '/upload-restore',
  requirePermission('RESTORE_BACKUPS'),
  upload.single('backup_file'),
  uploadAndRestoreBackup
);

export default router;