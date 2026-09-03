import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export const validateBody = (schema: z.ZodType) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ message: 'بيانات الطلب غير صالحة', errors: result.error });
  req.body = result.data;
  return next();
};