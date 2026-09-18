// Copyright (c) 2026 — Phase 3: API error codes
// طبقة أكواد أخطاء الـAPI المستقرة للترجمة في الواجهة.
// القاعدة الذهبية: code يُضاف ولا يُعاد استخدامه بمعنى مختلف.
// لا تغيّر هذه الملفات business logic — مجرد إضافة حقل code للرسائل الظاهرة للمستخدم.
export const ApiErrorCode = {
  // جلسة ملغاة/منتهية من قبل مدير (كانت موجودة كنص حرفي — ثُبّتت هنا دون تغيير معناها)
  SESSION_REVOKED: 'SESSION_REVOKED',
  // جلسة غير صالحة بلا jti (توكن قديم/مخصص): تُنهي الجلسة مركزياً في الواجهة
  INVALID_SESSION: 'INVALID_SESSION',
  // توكن منتهي أو غير صالح (فشل verify): يُنهي الجلسة مركزياً في الواجهة
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  // 401 من الوسيط المركزي
  TOKEN_MISSING: 'TOKEN_MISSING',
  TOKEN_INVALID: 'TOKEN_INVALID',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  // 403 من الوسيط المركزي (صلاحيات/دور — لا تنهي الجلسة)
  FORBIDDEN: 'FORBIDDEN',
  ROLE_UNKNOWN: 'ROLE_UNKNOWN',
  // validation والملفات والمركزي العام
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_INVALID: 'FILE_INVALID',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

// أكواد تُنهي الجلسة مركزياً في الواجهة (إلى جانب SESSION_REVOKED الموجود مسبقاً)
export const SESSION_ENDING_CODES: readonly string[] = [
  'SESSION_REVOKED',
  ApiErrorCode.INVALID_SESSION,
  ApiErrorCode.TOKEN_EXPIRED,
];
