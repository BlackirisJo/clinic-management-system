import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, logoutAll, changePassword } from './auth.controller';
import { authenticateJWT, AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { pool } from '../../config/database';

const router = Router();
// حد معدل تسجيل الدخول: يُحتسب فقط المحاولات الفاشلة (حماية brute-force)
// حتى لا يُقفل مستخدمو مكتب مشترك (IP واحد) بسبب دخولاتهم الناجحة المتكررة.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'محاولات تسجيل الدخول كثيرة، حاول لاحقاً' },
});

// مسار تسجيل الدخول المتاح للعموم
router.post('/login', loginLimiter, login);

// مسار محمي باختبار التوكن والصلاحيات لاسترجاع بيانات المستخدم الحالي
router.get('/me', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const isForcePasswordChange = await pool.query(
    'SELECT is_force_password_change FROM users WHERE user_id = $1',
    [req.user?.userId]
  ).then((r) => Boolean(r.rowCount && r.rows[0]?.is_force_password_change));
  res.status(200).json({
    message: 'تم التوثيق بنجاح',
    user: { ...req.user, is_force_password_change: isForcePasswordChange },
  });
});
router.post('/logout', authenticateJWT, logout);
router.post('/logout-all', authenticateJWT, logoutAll);
router.post('/change-password', authenticateJWT, changePassword);

export default router;