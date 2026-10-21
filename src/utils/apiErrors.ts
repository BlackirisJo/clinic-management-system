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
  // فاتورة سابقة للعتبة: paid_amount فيها تأكيد تاريخي، والتسوية مغلقة عليها
  LEGACY_INVOICE_READ_ONLY: 'LEGACY_INVOICE_READ_ONLY',
  // لا صف عتبة في قاعدة البيانات: لا يُكتب مال على هذا العمود إطلاقاً
  SETTLEMENT_CUTOVER_MISSING: 'SETTLEMENT_CUTOVER_MISSING',
  // Phase 10G.4b — استرداد نقدي. كلها رفضات صريحة لا استثناءات صامتة:
  // لا مبلغ خارج ما وصل، ولا استحقاق غير قائم، ولا نقد يعود لمَن لم يدفع.
  // الدفعة الملغاة لا تُردّ: لا نقد يعود من سطر ألغاه أحد.
  PAYMENT_VOIDED: 'PAYMENT_VOIDED',
  // المطلوب أكبر من نقد الدفعة بعد خصم كل الاستردادات الحية عليها
  REFUND_EXCEEDS_PAYMENT: 'REFUND_EXCEEDS_PAYMENT',
  // ائتمان الإرجاع إمّا معدوم (دواء غير مدفوع) أو مستنفد بالفعل
  NO_REFUND_ENTITLEMENT: 'NO_REFUND_ENTITLEMENT',
  // الاستحقاق حقّ المريض، فلا يُفرَّغ من نقد شركة التأمين
  PAYER_MISMATCH: 'PAYER_MISMATCH',
  // لا مصدر أسعار صرف في النظام: عملة مختلفة تُرفض ولا تُحوَّل
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  // فاتورة تجمع بنوداً من أكثر من عيادة: لا أساس صادق لنسبة استرداد واحد إليها
  CROSS_CLINIC_INVOICE: 'CROSS_CLINIC_INVOICE',
  // Phase 10G.6 — روشتة. الرفضات Business تُ/preferences بـ 409 مع code مستقر،
  // وأخطاء DB المعروفة تُpreferences بـ code تطبيقي آمن، والUnknown يبقى INTERNAL_ERROR.
  // ال visiting لا تنتمي للمريض/العيادة/طبيب التسجيل — رفض تشغيلي لا خطأ خادم.
  PRESCRIPTION_VISIT_OWNERSHIP: 'PRESCRIPTION_VISIT_OWNERSHIP',
  // مفتاح دواء غير موجود أو خارج النطاق: فشل مفتاح، لا فشل خادم.
  PRESCRIPTION_INVALID_REFERENCE: 'PRESCRIPTION_INVALID_REFERENCE',
  // بند الروشتة غير صحيح: كمية غير موجبة أو وحدة قياس غير معروفة.
  PRESCRIPTION_INVALID_ITEM: 'PRESCRIPTION_INVALID_ITEM',
  // ————— تقويم العطل الرسمية والجدولة —————
  // التاريخ عطلة رسمية: الحجز مرفوض ولا يُتجاوز بجدول العمل.
  HOLIDAY_CLOSED: 'HOLIDAY_CLOSED',
  // الطبيب في إجازة معتمدة: الحجز مرفوض ولا يتجاوزه استثناء عمل.
  DOCTOR_LEAVE: 'DOCTOR_LEAVE',
  // تعارض بين إجازة معتمدة واستثناء عمل: يُرفض صريحاً ولا يُحلّ صامتاً.
  LEAVE_CONFLICT: 'LEAVE_CONFLICT',
  // تعارض تقويمي آخر (عطلة مكررة، استثناء مكرر).
  CALENDAR_CONFLICT: 'CALENDAR_CONFLICT',
  // من طلب لا يوثّق نفسه: الاعتماد الذاتي مرفوض.
  SELF_APPROVAL_FORBIDDEN: 'SELF_APPROVAL_FORBIDDEN',
  // تغيير تقويمي يؤثر على مواعيد قائمة: يلزم تأكيد صريح بعد معاينة الأثر.
  IMPACT_CONFIRMATION_REQUIRED: 'IMPACT_CONFIRMATION_REQUIRED',
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
