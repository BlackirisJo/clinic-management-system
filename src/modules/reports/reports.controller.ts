import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest, isGlobalFinanceRole } from '../../middlewares/auth.middleware';
import { ReportQuery } from './reports.validation';

const getScope = (req: AuthenticatedRequest, query: ReportQuery) => {
  // المالية المركزية (مدير النظام/المحاسب/السوبر): كل العيادات افتراضياً،
  // أو عيادة محددة إذا مُرّر فلتر clinic_id صريح من الاستعلام
  if (isGlobalFinanceRole(req)) return query.clinic_id ?? null;
  // باقي الأدوار: عيادتهم المسندة فقط (null إن لم تكن لديهم عيادة)
  return req.user?.clinicId ?? null;
};

const dateBounds = (query: ReportQuery) => ({
  from: query.date_from ?? '1900-01-01',
  to: query.date_to ?? '2999-12-31',
});

export const getOverviewReport = async (req: AuthenticatedRequest, res: Response) => {
  const query = res.locals.reportQuery as ReportQuery;
  const clinicId = getScope(req, query);
  const { from, to } = dateBounds(query);
  try {
    const [patients, visits, appointments, prescriptions, financial] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM patients WHERE ($1::int IS NULL OR clinic_id = $1) AND created_at >= $2 AND created_at < ($3::date + INTERVAL '1 day')`, [clinicId, from, to]),
      pool.query(`SELECT COUNT(*)::int AS total FROM visits WHERE ($1::int IS NULL OR clinic_id = $1) AND visit_date >= $2 AND visit_date < ($3::date + INTERVAL '1 day')`, [clinicId, from, to]),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed, COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled FROM appointments WHERE ($1::int IS NULL OR clinic_id = $1) AND appointment_date BETWEEN $2 AND $3`, [clinicId, from, to]),
      pool.query(`SELECT COUNT(*)::int AS total FROM prescriptions p JOIN visits v ON v.visit_id = p.visit_id WHERE ($1::int IS NULL OR v.clinic_id = $1) AND p.created_at >= $2 AND p.created_at < ($3::date + INTERVAL '1 day')`, [clinicId, from, to]),
      pool.query(`WITH scoped_invoices AS (SELECT DISTINCT i.invoice_id, i.discount_amount, i.net_amount, i.paid_amount FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.invoice_id WHERE ($1::int IS NULL OR ii.clinic_id = $1) AND i.created_at >= $2 AND i.created_at < ($3::date + INTERVAL '1 day')) SELECT (SELECT COALESCE(SUM(ii.price * ii.quantity), 0) FROM invoice_items ii WHERE ii.invoice_id IN (SELECT invoice_id FROM scoped_invoices) AND ($1::int IS NULL OR ii.clinic_id = $1))::numeric AS revenue, (SELECT COALESCE(SUM(ii.doctor_share), 0) FROM invoice_items ii WHERE ii.invoice_id IN (SELECT invoice_id FROM scoped_invoices) AND ($1::int IS NULL OR ii.clinic_id = $1))::numeric AS doctor_payout, COALESCE(SUM(discount_amount), 0)::numeric AS discounts, COALESCE(SUM(net_amount), 0)::numeric AS net, COALESCE(SUM(paid_amount), 0)::numeric AS paid, COALESCE(SUM(net_amount - paid_amount), 0)::numeric AS outstanding, (SELECT COALESCE(SUM(e.amount), 0)::numeric FROM expenses e WHERE ($1::int IS NULL OR e.clinic_id = $1) AND e.deleted_at IS NULL AND e.created_at >= $2 AND e.created_at < ($3::date + INTERVAL '1 day')) AS expenses FROM scoped_invoices`, [clinicId, from, to]),
    ]);
    return res.status(200).json({ period: { from, to }, clinic_id: clinicId, overview: { patients: patients.rows[0], visits: visits.rows[0], appointments: appointments.rows[0], prescriptions: prescriptions.rows[0], financial: { ...financial.rows[0], net_after_expenses: Math.max(0, Number(financial.rows[0]?.net || 0) - Number(financial.rows[0]?.expenses || 0)) } } });
  } catch (error) {
    console.error('Overview Report Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء التقرير الشامل' });
  }
};

export const getFinancialReport = async (req: AuthenticatedRequest, res: Response) => {
  const query = res.locals.reportQuery as ReportQuery;
  const clinicId = getScope(req, query);
  const { from, to } = dateBounds(query);
  try {
    const [summary, byPayment, expenses, byService, payouts] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS invoices, COALESCE(SUM(i.total_amount), 0)::numeric AS gross, COALESCE(SUM(i.discount_amount), 0)::numeric AS discounts, COALESCE(SUM(i.net_amount), 0)::numeric AS net, COALESCE(SUM(i.paid_amount), 0)::numeric AS paid, COALESCE(SUM(i.net_amount - i.paid_amount), 0)::numeric AS outstanding FROM invoices i WHERE i.created_at >= $2 AND i.created_at < ($3::date + INTERVAL '1 day') AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id AND ($1::int IS NULL OR ii.clinic_id = $1))`, [clinicId, from, to]),
      pool.query(`SELECT i.payment_type, COUNT(*)::int AS invoices, COALESCE(SUM(i.paid_amount), 0)::numeric AS paid FROM invoices i WHERE i.created_at >= $2 AND i.created_at < ($3::date + INTERVAL '1 day') AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.invoice_id AND ($1::int IS NULL OR ii.clinic_id = $1)) GROUP BY i.payment_type ORDER BY paid DESC`, [clinicId, from, to]),
      pool.query(`SELECT COUNT(*)::int AS expenses, COALESCE(SUM(amount), 0)::numeric AS total FROM expenses WHERE ($1::int IS NULL OR clinic_id = $1) AND deleted_at IS NULL AND created_at >= $2 AND created_at < ($3::date + INTERVAL '1 day')`, [clinicId, from, to]),
      pool.query(`SELECT cs.service_name, COUNT(ii.item_id)::int AS items, COALESCE(SUM(ii.price * ii.quantity), 0)::numeric AS revenue, COALESCE(SUM(ii.doctor_share), 0)::numeric AS doctor_payout FROM invoice_items ii JOIN clinic_services cs ON cs.service_id = ii.service_id WHERE ($1::int IS NULL OR ii.clinic_id = $1) AND ii.created_at >= $2 AND ii.created_at < ($3::date + INTERVAL '1 day') GROUP BY cs.service_name ORDER BY revenue DESC`, [clinicId, from, to]),
      pool.query(`SELECT COALESCE(SUM(ii.doctor_share), 0)::numeric AS total FROM invoice_items ii WHERE ($1::int IS NULL OR ii.clinic_id = $1) AND ii.created_at >= $2 AND ii.created_at < ($3::date + INTERVAL '1 day')`, [clinicId, from, to]),
    ]);
    return res.status(200).json({ period: { from, to }, summary: { ...summary.rows[0], doctor_payout: Number(payouts.rows[0]?.total || 0), net_after_expenses: Math.max(0, Number(summary.rows[0]?.net || 0) - Number(expenses.rows[0]?.total || 0)) }, payment_methods: byPayment.rows, expenses: expenses.rows[0], services: byService.rows });
  } catch (error) {
    console.error('Financial Report Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء التقرير المالي' });
  }
};

export const getClinicalReport = async (req: AuthenticatedRequest, res: Response) => {
  const query = res.locals.reportQuery as ReportQuery;
  const clinicId = getScope(req, query);
  const { from, to } = dateBounds(query);
  const offset = (query.page - 1) * query.limit;
  try {
    const [summary, doctors, medications] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS visits, COUNT(DISTINCT patient_id)::int AS unique_patients, COUNT(DISTINCT doctor_id)::int AS doctors FROM visits WHERE ($1::int IS NULL OR clinic_id = $1) AND visit_date >= $2 AND visit_date < ($3::date + INTERVAL '1 day')`, [clinicId, from, to]),
      pool.query(`SELECT u.user_id AS doctor_id, u.full_name AS doctor_name, COUNT(v.visit_id)::int AS visits, COUNT(DISTINCT v.patient_id)::int AS patients FROM visits v JOIN users u ON u.user_id = v.doctor_id WHERE ($1::int IS NULL OR v.clinic_id = $1) AND v.visit_date >= $2 AND v.visit_date < ($3::date + INTERVAL '1 day') GROUP BY u.user_id, u.full_name ORDER BY visits DESC LIMIT $4 OFFSET $5`, [clinicId, from, to, query.limit, offset]),
      pool.query(`SELECT m.trade_name, m.scientific_name, COUNT(*)::int AS prescribed_count FROM prescription_items pi JOIN prescriptions p ON p.prescription_id = pi.prescription_id JOIN medications m ON m.medication_id = pi.medication_id JOIN visits v ON v.visit_id = p.visit_id WHERE ($1::int IS NULL OR v.clinic_id = $1) AND p.created_at >= $2 AND p.created_at < ($3::date + INTERVAL '1 day') GROUP BY m.medication_id, m.trade_name, m.scientific_name ORDER BY prescribed_count DESC LIMIT $4 OFFSET $5`, [clinicId, from, to, query.limit, offset]),
    ]);
    return res.status(200).json({ period: { from, to }, summary: summary.rows[0], doctors: doctors.rows, medications: medications.rows, pagination: { page: query.page, limit: query.limit } });
  } catch (error) {
    console.error('Clinical Report Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء التقرير الطبي' });
  }
};

export const getAppointmentsReport = async (req: AuthenticatedRequest, res: Response) => {
  const query = res.locals.reportQuery as ReportQuery;
  const clinicId = getScope(req, query);
  const { from, to } = dateBounds(query);
  try {
    const result = await pool.query(`SELECT status, COUNT(*)::int AS total FROM appointments WHERE ($1::int IS NULL OR clinic_id = $1) AND appointment_date BETWEEN $2 AND $3 GROUP BY status ORDER BY total DESC`, [clinicId, from, to]);
    return res.status(200).json({ period: { from, to }, statuses: result.rows });
  } catch (error) {
    console.error('Appointments Report Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء تقرير المواعيد' });
  }
};

export const getPatientsReport = async (req: AuthenticatedRequest, res: Response) => {
  const query = res.locals.reportQuery as ReportQuery;
  const clinicId = getScope(req, query);
  const { from, to } = dateBounds(query);
  const offset = (query.page - 1) * query.limit;
  try {
    const result = await pool.query(`SELECT p.patient_id, p.full_name, p.phone, p.gender, p.created_at, COUNT(v.visit_id)::int AS visits, MAX(v.visit_date) AS last_visit FROM patients p LEFT JOIN visits v ON v.patient_id = p.patient_id AND v.clinic_id = p.clinic_id WHERE ($1::int IS NULL OR p.clinic_id = $1) AND p.created_at >= $2 AND p.created_at < ($3::date + INTERVAL '1 day') GROUP BY p.patient_id ORDER BY p.created_at DESC LIMIT $4 OFFSET $5`, [clinicId, from, to, query.limit, offset]);
    return res.status(200).json({ period: { from, to }, patients: result.rows, pagination: { page: query.page, limit: query.limit } });
  } catch (error) {
    console.error('Patients Report Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء تقرير المرضى' });
  }
};