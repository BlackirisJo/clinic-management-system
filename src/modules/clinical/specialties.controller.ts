import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { SPECIALTY_MODULES, DEFAULT_MODULE } from '../../specialties/registry';

// قائمة التخصصات من قاعدة البيانات مع دمج إعدادات الـworkflow من السجل البرمجي
export const listSpecialties = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.specialty_id, s.specialty_key, s.name_ar, s.name_en, s.description, s.is_active,
              COUNT(c.clinic_id)::int AS clinics_count
       FROM specialties s
       LEFT JOIN clinics c ON c.specialty_id = s.specialty_id
       GROUP BY s.specialty_id
       ORDER BY s.sort_order ASC, s.specialty_id ASC`
    );
    const specialties = result.rows.map((row) => {
      const moduleConfig = SPECIALTY_MODULES[row.specialty_key];
      return {
        ...row,
        module: moduleConfig ? {
          visitSections: moduleConfig.visitSections,
          extraFields: moduleConfig.extraFields ?? [],
          workflow: moduleConfig.workflow,
        } : {
          // تخصص جديد أُضيف في قاعدة البيانات فقط — يعمل تلقائياً بالإعدادات الافتراضية
          visitSections: DEFAULT_MODULE.visitSections,
          extraFields: DEFAULT_MODULE.extraFields ?? [],
          workflow: DEFAULT_MODULE.workflow,
        },
      };
    });
    return res.status(200).json({ specialties });
  } catch (error) {
    console.error('List Specialties Error:', error);
    return res.status(500).json({ message: 'حدث خطأ عند استرجاع التخصصات الطبية' });
  }
};