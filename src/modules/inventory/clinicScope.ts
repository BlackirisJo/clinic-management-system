import { AuthenticatedRequest, accessibleClinicIds, canManageAllClinics } from '../../middlewares/auth.middleware';

/* ==========================================================================
 * Phase 10B.2 — Shared clinic scoping for inventory-domain resources.
 * Single source of truth so isolation rules cannot drift between modules.
 * ========================================================================== */

export const parsePositiveId = (raw: unknown): number | null => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * يبني شرط حصر النتائج بعيادات المستخدم.
 * المدراء (canManageAllClinics) بلا تقييد، وغيرهم محصورون بعياداتهم المسندة.
 * القائمة الفارغة = لا عيادات مسموحة (deny-by-default) — لا تُترك بلا شرط أبداً.
 */
export const buildClinicScope = (
  req: AuthenticatedRequest,
  params: unknown[],
  column = 'i.clinic_id',
): { clause: string; params: unknown[] } => {
  if (canManageAllClinics(req)) return { clause: '', params };
  const clinicIds = accessibleClinicIds(req) ?? [];
  return {
    clause: ` AND ${column} = ANY($${params.length + 1}::int[])`,
    params: [...params, clinicIds],
  };
};

export const isClinicAccessible = (req: AuthenticatedRequest, clinicId: number): boolean => {
  if (canManageAllClinics(req)) return true;
  return (accessibleClinicIds(req) ?? []).includes(clinicId);
};
