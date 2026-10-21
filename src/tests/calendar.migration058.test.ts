import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T1 — مخطط التقويم (ترحيل 058).
 *
 * يتحقق من وجود الجداول والقيود والفهارس الجزئية وبذر الصلاحيات،
 * ومن أن إعادة تطبيق الترحيل لا تكسر شيئاً (idempotency).
 * كل القراءة على clinic_db_test فقط.
 */

import { testPool, withTransaction, assertTestDatabase } from './helpers/calendarFixtures';

const MIGRATION_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '058_holiday_calendar.sql');
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

const SCHEDULING_PERMISSIONS = [
  'VIEW_HOLIDAYS',
  'MANAGE_HOLIDAYS',
  'APPROVE_HOLIDAYS',
  'VIEW_DOCTOR_LEAVE',
  'MANAGE_DOCTOR_LEAVE',
  'APPROVE_DOCTOR_LEAVE',
  'MANAGE_WORK_EXCEPTIONS',
  'APPROVE_WORK_EXCEPTIONS',
  'VIEW_SCHEDULE_IMPACT',
];

test('058: جداول التقويم الخمسة موجودة', async () => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT c.relname AS table_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname IN ('clinic_holidays','doctor_leave','work_exceptions','calendar_changes','calendar_change_notifications')
       ORDER BY c.relname`
    );
    const names = rows.map((row) => row.table_name);
    for (const expected of ['calendar_change_notifications', 'calendar_changes', 'clinic_holidays', 'doctor_leave', 'work_exceptions']) {
      assert.ok(names.includes(expected), `الجدول ${expected} مفقود`);
    }
  });
});

test('058: الفهارس الفريدة الجزئية على النطاق النشط موجودة', async () => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('uq_clinic_holidays_national','uq_clinic_holidays_clinic','uq_doctor_leave_approved','uq_work_exceptions_approved')`
    );
    const defs = new Map(rows.map((row) => [row.indexname, row.indexdef]));
    assert.equal(defs.size, 4, 'الفهارس الفريدة الأربعة مفقودة');

    //national: التفرّد على التاريخ وحده عندما تكون النطاق NULL
    assert.match(defs.get('uq_clinic_holidays_national') ?? '', /holiday_date/);
    assert.match(defs.get('uq_clinic_holidays_national') ?? '', /clinic_id IS NULL/);
    assert.match(defs.get('uq_clinic_holidays_national') ?? '', /'ACTIVE'/);

    // عيادة: التفرّد على (العيادة، التاريخ)
    assert.match(defs.get('uq_clinic_holidays_clinic') ?? '', /clinic_id, holiday_date/);
    assert.match(defs.get('uq_clinic_holidays_clinic') ?? '', /'ACTIVE'/);

    // الإجازة: التفرّد على النطاق المعتمد فقط (PENDING متعدد مسموح)
    assert.match(defs.get('uq_doctor_leave_approved') ?? '', /doctor_id, clinic_id, start_date, end_date/);
    assert.match(defs.get('uq_doctor_leave_approved') ?? '', /'APPROVED'/);

    // الاستثناء: التفرّد على (العيادة، الطبيب، التاريخ) للمعتمد فقط
    assert.match(defs.get('uq_work_exceptions_approved') ?? '', /clinic_id, doctor_id, exception_date/);
    assert.match(defs.get('uq_work_exceptions_approved') ?? '', /'APPROVED'/);
  });
});

test('058: قيود CHECK المسمّاة موجودة', async () => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT conname FROM pg_constraint
       WHERE conname IN (
         'clinic_holidays_type_check','clinic_holidays_status_check',
         'doctor_leave_dates_check','doctor_leave_type_check','doctor_leave_status_check',
         'work_exceptions_status_check','work_exceptions_time_check',
         'calendar_changes_decision_check','calendar_changes_notification_status_check',
         'calendar_change_notifications_channel_check','calendar_change_notifications_status_check'
       )`
    );
    const names = new Set(rows.map((row) => row.conname));
    for (const expected of [
      'clinic_holidays_type_check',
      'clinic_holidays_status_check',
      'doctor_leave_dates_check',
      'work_exceptions_time_check',
      'calendar_changes_notification_status_check',
      'calendar_change_notifications_channel_check',
    ]) {
      assert.ok(names.has(expected), `القيد ${expected} مفقود`);
    }
  });
});

test('058: channelNotification لا يقبل سوى MANUAL (لا ادعاء بإرسال)', async () => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'calendar_change_notifications_channel_check'`
    );
    assert.match(rows[0]?.def ?? '', /MANUAL/);
  });
});

test('058: المفاتيح foreign keys تربط الجداول الجديدة بالمستخدمين والعيادات', async () => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT conrelid::regclass::text AS table_name, count(*)::int AS fk_count
       FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN ('clinic_holidays'::regclass, 'doctor_leave'::regclass, 'work_exceptions'::regclass,
                          'calendar_changes'::regclass, 'calendar_change_notifications'::regclass)
       GROUP BY conrelid::regclass::text`
    );
    const counts = new Map(rows.map((row) => [row.table_name, Number(row.fk_count)]));
    assert.ok((counts.get('clinic_holidays') ?? 0) >= 1, 'clinic_holidays بلا مفاتيح أجنبية');
    assert.ok((counts.get('doctor_leave') ?? 0) >= 2, 'doctor_leave بلا مفاتيح أجنبية');
    assert.ok((counts.get('work_exceptions') ?? 0) >= 3, 'work_exceptions بلا مفاتيح أجنبية');
    assert.ok((counts.get('calendar_change_notifications') ?? 0) >= 2, 'calendar_change_notifications بلا مفاتيح أجنبية');
  });
});

test('058: مفاتيح صلاحيات الجدولة مبذورة وممنوحة للأدوار', async () => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT permission_key FROM permissions WHERE permission_group = 'Scheduling'`
    );
    const keys = new Set(rows.map((row) => row.permission_key));
    for (const key of SCHEDULING_PERMISSIONS) {
      assert.ok(keys.has(key), `مفتاح الصلاحية ${key} غير مبذور`);
    }

    const grants = await client.query(
      `SELECT r.role_name, p.permission_key
       FROM role_permissions rp
       JOIN roles r ON r.role_id = rp.role_id
       JOIN permissions p ON p.permission_id = rp.permission_id
       WHERE p.permission_key = ANY($1::text[])`,
      [SCHEDULING_PERMISSIONS]
    );
    const granted = new Set(grants.rows.map((row) => `${row.role_name}:${row.permission_key}`));

    // القراءة متاحة للطبيب ولموظف الاستقبال
    for (const role of ['DOCTOR', 'RECEPTIONIST']) {
      assert.ok(granted.has(`${role}:VIEW_HOLIDAYS`), `${role} بلا VIEW_HOLIDAYS`);
      assert.ok(granted.has(`${role}:VIEW_SCHEDULE_IMPACT`), `${role} بلا VIEW_SCHEDULE_IMPACT`);
      assert.ok(granted.has(`${role}:MANAGE_DOCTOR_LEAVE`), `${role} بلا MANAGE_DOCTOR_LEAVE`);
    }
    // الاعتماد محصور بالإداريين
    for (const role of ['SYSTEM_ADMIN', 'SUPER_ADMIN']) {
      assert.ok(granted.has(`${role}:APPROVE_HOLIDAYS`), `${role} بلا APPROVE_HOLIDAYS`);
      assert.ok(granted.has(`${role}:APPROVE_DOCTOR_LEAVE`), `${role} بلا APPROVE_DOCTOR_LEAVE`);
      assert.ok(granted.has(`${role}:APPROVE_WORK_EXCEPTIONS`), `${role} بلا APPROVE_WORK_EXCEPTIONS`);
    }
    // الاستقبال يقترح ولا يعتمد
    assert.ok(granted.has('RECEPTIONIST:MANAGE_HOLIDAYS'), 'RECEPTIONIST بلا MANAGE_HOLIDAYS');
    assert.ok(!granted.has('RECEPTIONIST:APPROVE_HOLIDAYS'), 'RECEPTIONIST لا يجب أن يملك APPROVE_HOLIDAYS');
  });
});

test('057: عمود clinics.timezone موجود وNOT NULL وافتراضيه Asia/Amman', async () => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'clinics' AND column_name = 'timezone'`
    );
    assert.equal(rows.length, 1, 'عمود timezone مفقود في clinics');
    assert.equal(rows[0].is_nullable, 'NO', 'timezone يجب أن يكون NOT NULL');
    assert.match(String(rows[0].column_default), /Asia\/Amman/);
  });
});

test('058: إعادة تطبيق الترحيل لا تفشل (idempotency)', async () => {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await assertTestDatabase(client);
    try {
      await client.query(MIGRATION_SQL);
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
});
