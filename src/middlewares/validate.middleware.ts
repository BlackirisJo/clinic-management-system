import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiErrorCode } from '../utils/apiErrors';
import { AppError } from './error.middleware';

export const validateBody = (schema: z.ZodType) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  // Phase 3: code مستقر للترجمة — message والـ status والـ errors كما هي تماماً
  if (!result.success) return next(new AppError('بيانات الطلب غير صالحة', 400, ApiErrorCode.VALIDATION_ERROR, true, result.error));
  req.body = result.data;
  return next();
};