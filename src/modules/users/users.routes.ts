import { NextFunction, Response, Router } from 'express';
import { z } from 'zod';
import { authenticateJWT, AuthenticatedRequest, requirePermission } from '../../middlewares/auth.middleware';
import { createUser, listUsers, updateUser } from './users.controller';
import { createUserSchema, updateUserSchema } from './users.validation';

const router = Router();
const validate = (schema: z.ZodType) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ message: 'بيانات المستخدم غير صالحة', errors: result.error });
  req.body = result.data;
  return next();
};

router.use(authenticateJWT, requirePermission('MANAGE_USERS'));
router.get('/', listUsers);
router.post('/', validate(createUserSchema), createUser);
router.patch('/:id', validate(updateUserSchema), updateUser);

export default router;