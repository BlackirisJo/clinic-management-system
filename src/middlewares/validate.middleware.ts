import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiErrorCode } from '../utils/apiErrors';

export const validateBody = (schema: z.ZodType) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  // Phase 3: code مستقر للترجمة — message والـ status والـ errors كما هي تماماً
  if (!result.success) return res.status(400).json({ message: 'بيانات الطلب غير صالحة', code: ApiErrorCode.VALIDATION_ERROR, errors: result.error });
  req.body = result.data;
  return next();
};