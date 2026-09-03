import { z } from 'zod';

export const reportQuerySchema = z.object({
  clinic_id: z.coerce.number().int().positive().optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
}).refine((query) => !query.date_from || !query.date_to || query.date_from <= query.date_to, {
  message: 'date_from must be before or equal to date_to',
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;