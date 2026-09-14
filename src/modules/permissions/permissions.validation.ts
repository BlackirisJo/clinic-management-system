import { z } from 'zod';

// قائمة مفاتيح الصلاحيات المرسلة من الواجهة
const permissionKeysSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(500, 'عدد الصلاحيات المرسلة كبير جداً');

// إنشاء دور جديد — الاسم بأحرف إنجليزية كبيرة وشرطات سفلية (اصطلاح النظام)
export const createRoleSchema = z.object({
  role_name: z
    .string()
    .trim()
    .min(2, 'اسم الدور قصير جداً')
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'اسم الدور يجب أن يتكون من أحرف إنجليزية كبيرة وأرقام وشرطات سفلية فقط'),
  description: z.string().trim().max(300).optional(),
  permission_keys: permissionKeysSchema.optional(),
});

// تعديل بيانات الدور (الاسم والوصف فقط — الصلاحيات تُعدل عبر مسار مستقل)
export const updateRoleSchema = z.object({
  role_name: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
  description: z.string().trim().max(300).optional(),
});

// حفظ صلاحيات الدور (استبدال كامل)
export const setRolePermissionsSchema = z.object({
  permission_keys: permissionKeysSchema,
});

// تفعيل/تعطيل دور
export const updateRoleStatusSchema = z.object({
  is_active: z.boolean(),
});