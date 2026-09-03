import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, logoutAll } from './auth.controller';
import { authenticateJWT, AuthenticatedRequest } from '../../middlewares/auth.middleware';

const router = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'محاولات تسجيل الدخول كثيرة، حاول لاحقاً' },
});

// مسار تسجيل الدخول المتاح للعموم
router.post('/login', loginLimiter, login);

// مسار محمي باختبار التوكن والصلاحيات لاسترجاع بيانات المستخدم الحالي
router.get('/me', authenticateJWT, (req: AuthenticatedRequest, res: Response) => {
  res.status(200).json({
    message: 'تم التوثيق بنجاح',
    user: req.user,
  });
});
router.post('/logout', authenticateJWT, logout);
router.post('/logout-all', authenticateJWT, logoutAll);

export default router;