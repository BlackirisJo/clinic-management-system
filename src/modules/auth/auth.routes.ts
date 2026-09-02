import { Router, Response } from 'express';
import { login } from './auth.controller';
import { authenticateJWT, AuthenticatedRequest } from '../../middlewares/auth.middleware';

const router = Router();

// مسار تسجيل الدخول المتاح للعموم
router.post('/login', login);

// مسار محمي باختبار التوكن والصلاحيات لاسترجاع بيانات المستخدم الحالي
router.get('/me', authenticateJWT, (req: AuthenticatedRequest, res: Response) => {
  res.status(200).json({
    message: 'تم التوثيق بنجاح',
    user: req.user,
  });
});

export default router;