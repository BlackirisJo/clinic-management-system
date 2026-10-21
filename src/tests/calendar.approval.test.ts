import './helpers/appTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * T5 — فصل «التعديل» عن «الاعتماد» في إجازات الأطباء واستثناءات العمل.
 *
 * القواعد:
 *  1) من طلب لا يوثّق نفسه: الاعتماد الذاتي مرفوض (403 SELF_APPROVAL_FORBIDDEN).
 *  2) الاعتماد يحتاج صلاحية APROVE_* — ودور بلا هذه الصلاحية يُرفض عند
 *     middleware (requirePermission) لا عند写入 في القاعدة.
 *  3) استثناء عمل معتمد يمنع اعتماد إجازة تغطيه (409 LEAVE_CONFLICT).
 */

import { createLeave, decideLeave, createException } from '../modules/calendar/calendar.controller';
import { requirePermission } from '../middlewares/auth.middleware';
import { testPool, createCommittedFixtures, cleanupCommittedFixtures, futureDate } from './helpers/calendarFixtures';
import { createMockReq, createMockRes } from './helpers/controllerHarness';

const doctorUser = (userId: number, clinicId: number, permissions: string[] = []) => ({
  userId,
  roleName: 'DOCTOR',
  permissions,
  clinicId,
  clinicIds: [clinicId],
});

const adminUser = (userId: number) => ({
  userId,
  roleName: 'SYSTEM_ADMIN',
  permissions: ['VIEW_DOCTOR_LEAVE', 'MANAGE_DOCTOR_LEAVE', 'APPROVE_DOCTOR_LEAVE', 'MANAGE_WORK_EXCEPTIONS'],
  clinicId: null,
  clinicIds: [] as number[],
});

test('الاعتماد الذاتي مرفوض: من طلب الإجازة لا يستطيع اعتمادها', async (t) => {
  const fx = await createCommittedFixtures('approval-self');
  t.after(() => cleanupCommittedFixtures(fx));

  const start = futureDate(80);
  const end = futureDate(81);

  // الطبيب يطلب إجازة لنفسه
  const requested = createMockRes();
  await createLeave(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId, ['MANAGE_DOCTOR_LEAVE']),
      body: { doctor_id: fx.doctorId, clinic_id: fx.clinicId, start_date: start, end_date: end, reason: 'إجازة اختبار' },
    }),
    requested.res
  );
  assert.equal(requested.captured.status, 201, JSON.stringify(requested.captured.body));
  const leaveId = Number(requested.captured.body.leave.leave_id);
  assert.equal(requested.captured.body.leave.status, 'PENDING', 'الطلب يبدأ بانتظار الاعتماد');

  // نفس الطبيب يحاول الاعتماد ⇒ مرفوض
  const selfApprove = createMockRes();
  await decideLeave(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId, ['APPROVE_DOCTOR_LEAVE']),
      params: { id: String(leaveId) },
      body: { status: 'APPROVED' },
    }),
    selfApprove.res
  );
  assert.equal(selfApprove.captured.status, 403, 'الاعتماد الذاتي مرفوض');
  assert.equal(selfApprove.captured.body.code, 'SELF_APPROVAL_FORBIDDEN');

  // والإجازة بقيت PENDING — لا تغيير جزئي
  const row = await testPool.query(`SELECT status FROM doctor_leave WHERE leave_id = $1`, [leaveId]);
  assert.equal(row.rows[0].status, 'PENDING', 'لم تُعتمد الإجازة');
});

test('الطبيب لا يطلب إجازة لغيره', async (t) => {
  const fx = await createCommittedFixtures('approval-other');
  const other = await createCommittedFixtures('approval-other-2');
  t.after(async () => {
    await cleanupCommittedFixtures(fx);
    await cleanupCommittedFixtures(other);
  });

  const res = createMockRes();
  await createLeave(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId, ['MANAGE_DOCTOR_LEAVE']),
      body: {
        doctor_id: other.doctorId,
        clinic_id: fx.clinicId,
        start_date: futureDate(82),
        end_date: futureDate(82),
        reason: 'محاولة',
      },
    }),
    res.res
  );
  assert.equal(res.captured.status, 403, 'الطبيب لا يطلب إجازة لزميله');
});

test('اعتماد إجازة بصلاحية APROVE: ينجح ويسجّل القرار', async (t) => {
  const fx = await createCommittedFixtures('approval-admin');
  t.after(() => cleanupCommittedFixtures(fx));

  const start = futureDate(83);
  const end = futureDate(84);

  const requested = createMockRes();
  await createLeave(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId, ['MANAGE_DOCTOR_LEAVE']),
      body: { doctor_id: fx.doctorId, clinic_id: fx.clinicId, start_date: start, end_date: end },
    }),
    requested.res
  );
  assert.equal(requested.captured.status, 201, JSON.stringify(requested.captured.body));
  const leaveId = Number(requested.captured.body.leave.leave_id);

  const approved = createMockRes();
  await decideLeave(
    createMockReq({
      user: adminUser(fx.adminUserId),
      params: { id: String(leaveId) },
      body: { status: 'APPROVED' },
    }),
    approved.res
  );
  assert.equal(approved.captured.status, 200, JSON.stringify(approved.captured.body));
  assert.equal(approved.captured.body.leave.status, 'APPROVED');

  const change = await testPool.query(
    `SELECT change_type, decision FROM calendar_changes
     WHERE entity_type = 'DOCTOR_LEAVE' AND entity_id = $1 ORDER BY change_id DESC LIMIT 1`,
    [leaveId]
  );
  assert.equal(change.rows[0].change_type, 'LEAVE_APPROVED');
  assert.equal(change.rows[0].decision, 'CONFIRMED');
});

test('اعتماد إجازة تتعارض مع استثناء عمل معتمد: 409 LEAVE_CONFLICT', async (t) => {
  const fx = await createCommittedFixtures('approval-conflict');
  t.after(() => cleanupCommittedFixtures(fx));

  const date = futureDate(85);

  const exceptionRes = createMockRes();
  await createException(
    createMockReq({
      user: adminUser(fx.adminUserId),
      body: {
        doctor_id: fx.doctorId,
        clinic_id: fx.clinicId,
        exception_date: date,
        reason: 'استثناء معتمد مسبقاً',
      },
    }),
    exceptionRes.res
  );
  assert.equal(exceptionRes.captured.status, 201, JSON.stringify(exceptionRes.captured.body));
  const exceptionId = Number(exceptionRes.captured.body.exception.exception_id);
  await testPool.query(
    `UPDATE work_exceptions SET status = 'APPROVED', approved_at = CURRENT_TIMESTAMP WHERE exception_id = $1`,
    [exceptionId]
  );

  const leaveRes = createMockRes();
  await createLeave(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId, ['MANAGE_DOCTOR_LEAVE']),
      body: { doctor_id: fx.doctorId, clinic_id: fx.clinicId, start_date: date, end_date: date },
    }),
    leaveRes.res
  );
  assert.equal(leaveRes.captured.status, 201);
  const leaveId = Number(leaveRes.captured.body.leave.leave_id);

  const approveRes = createMockRes();
  await decideLeave(
    createMockReq({
      user: adminUser(fx.adminUserId),
      params: { id: String(leaveId) },
      body: { status: 'APPROVED' },
    }),
    approveRes.res
  );
  assert.equal(approveRes.captured.status, 409, 'الاعتماد يجب أن يُرفض عند التعارض');
  assert.equal(approveRes.captured.body.code, 'LEAVE_CONFLICT');

  const row = await testPool.query(`SELECT status FROM doctor_leave WHERE leave_id = $1`, [leaveId]);
  assert.equal(row.rows[0].status, 'PENDING', 'الإجازة لم تُعتمد');
});

test('middleware: صلاحية الاعتماد مطلوبة، والمدير يتجاوز الفحص (سلوك موثّق)', async () => {
  // دور بلا صلاحية الاعتماد ⇒ AppError 403
  let captured: any = null;
  const res = createMockRes();
  await requirePermission('APPROVE_DOCTOR_LEAVE')(
    createMockReq({ user: doctorUser(999, 1, ['VIEW_DOCTOR_LEAVE']) }),
    res.res,
    (err?: any) => {
      captured = err ?? 'next';
    }
  );
  assert.ok(captured instanceof Error, 'يجب تمرير خطأ 403');
  const appError = captured as any;
  assert.equal(appError.statusCode, 403, 'الدور غير المخوّل يُرفض');
  assert.equal(appError.code, 'FORBIDDEN');

  // المدير يتجاوز الفحص — وهو ما يجعل فصل الاعتماد متطلّباً تحققاً صريحاً في المتحكم
  let adminResult: any = null;
  await requirePermission('APPROVE_DOCTOR_LEAVE')(
    createMockReq({ user: adminUser(1) }),
    res.res,
    (err?: any) => {
      adminResult = err ?? 'next';
    }
  );
  assert.equal(adminResult, 'next', 'المدير يتجاوز الفحص (R13) — ولهذا وُجد التحقق الذاتي في المتحكم');
});
