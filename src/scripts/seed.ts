import bcrypt from 'bcryptjs';
import { pool } from '../config/database';

// قائمة الصلاحيات الشاملة للنظام
const PERMISSIONS = [
  // إدارة العيادات والمستخدمين
  { key: 'MANAGE_CLINICS', group: 'System', desc: 'إضافة وتعديل العيادات' },
  { key: 'MANAGE_USERS', group: 'System', desc: 'إدارة حسابات المستخدمين وأدوارهم' },
  
  // إدارة المرضى والزيارات
  { key: 'VIEW_PATIENTS', group: 'Patients', desc: 'عرض ملفات المرضى' },
  { key: 'CREATE_PATIENT', group: 'Patients', desc: 'إضافة مريض جديد' },
  { key: 'EDIT_PATIENTS', group: 'Patients', desc: 'تعديل بيانات المرضى' },
  { key: 'EDIT_PATIENT_MEDICAL', group: 'Patients', desc: 'إكمال وتحديث البيانات الطبية للمريض (الحساسيات والأمراض المزمنة)' },
  { key: 'CREATE_VISIT', group: 'Visits', desc: 'تسجيل زيارة جديدة للمريض' },
  { key: 'SHARE_PATIENT_RECORDS', group: 'Patients', desc: 'مشاركة السجلات الطبية مع عيادات أخرى' },
  { key: 'VIEW_SHARED_PATIENT_RECORDS', group: 'Patients', desc: 'عرض السجلات الطبية المشتركة' },
  { key: 'VIEW_APPOINTMENTS', group: 'Appointments', desc: 'عرض المواعيد' },
  { key: 'MANAGE_APPOINTMENTS', group: 'Appointments', desc: 'إدارة المواعيد' },
  
  // الروشتات والأدوية
  { key: 'CREATE_PRESCRIPTION', group: 'Prescriptions', desc: 'إنشاء روشتة طبية' },
  { key: 'VIEW_PRESCRIPTIONS', group: 'Prescriptions', desc: 'عرض الروشتات الطبية' },
  { key: 'VIEW_MEDICATIONS', group: 'Pharmacy', desc: 'عرض دليل الأدوية' },
  { key: 'MANAGE_MEDICATIONS', group: 'Pharmacy', desc: 'إضافة وتعديل الأدوية' },
  { key: 'RECORD_PRESCRIPTION_FULFILMENT', group: 'Pharmacy', desc: 'تسجيل قرار المريض بشأن تنفيذ بند الروشتة' },
  
  // المالية والفواتير
  { key: 'MANAGE_SERVICES', group: 'Finance', desc: 'إدارة قائمة الخدمات وأسعارها' },
  { key: 'CREATE_INVOICE', group: 'Finance', desc: 'إصدار فواتير للخدمات والزيارات' },
  { key: 'VIEW_INVOICES', group: 'Finance', desc: 'عرض الفواتير والتقارير المالية' },
  { key: 'RECORD_PAYMENT', group: 'Finance', desc: 'تسجيل دفعة محصّلة على فاتورة' },
  { key: 'RECORD_REFUND', group: 'Finance', desc: 'تسجيل استرداد نقدي على دفعة محصّلة' },
  { key: 'CREATE_EXPENSE', group: 'Finance', desc: 'تسجيل المصاريف التشغيلية' },
  { key: 'VIEW_FINANCIAL_REPORTS', group: 'Finance', desc: 'الاطلاع على الإحصائيات والأرباح' },
  { key: 'VIEW_REPORTS', group: 'Reports', desc: 'عرض التقارير الشاملة للنظام' },

  // النسخ الاحتياطي
    { key: 'MANAGE_PERMISSIONS', group: 'System', desc: 'إدارة الأدوار والصلاحيات وربطها بالمستخدمين' },
  { key: 'DELETE_USERS', group: 'System', desc: 'حذف/تعطيل حسابات المستخدمين مع إنهاء جميع جلساتهم' },
  { key: 'MANAGE_BACKUPS', group: 'System', desc: 'إنشاء وتنزيل النسخ الاحتياطية' },
  { key: 'VIEW_BACKUP_LOGS', group: 'System', desc: 'عرض سجلات النسخ الاحتياطي' },
  { key: 'RESTORE_BACKUPS', group: 'System', desc: 'استرجاع النسخ الاحتياطية' },
  { key: 'MANAGE_PREGNANCY', group: 'Clinical', desc: 'إنشاء ومتابعة سجلات الحمل في عيادة النسائية والتوليد'},
  { key: 'GENERATE_EMERGENCY_REPORT', group: 'Clinical', desc: 'إنشاء تقرير طبي طارئ للعيادة'},
  { key: 'VIEW_SYSTEM_LOGS', group: 'System', desc: 'عرض وسجلات النظام وتصديرها' },

// جدولة الأطباء وتقويم العطل الرسمية
  { key: 'VIEW_HOLIDAYS', group: 'Scheduling', desc: 'عرض تقويم العطل الرسمية واستثناءات العمل' },
  { key: 'MANAGE_HOLIDAYS', group: 'Scheduling', desc: ' Minor وتعديل ونقل العطل الرسمية (دون اعتمد)' },
  { key: 'APPROVE_HOLIDAYS', group: 'Scheduling', desc: 'اعتماد وإلغاء العطل الرسمية (قرار)' },
  { key: 'VIEW_DOCTOR_LEAVE', group: 'Scheduling', desc: 'عرض إجازات الأطباء' },
  { key: 'MANAGE_DOCTOR_LEAVE', group: 'Scheduling', desc: 'طلب إجازة وتعديلها (دون اعتماد)' },
  { key: 'APPROVE_DOCTOR_LEAVE', group: 'Scheduling', desc: 'اعتماد أو رفض إجازة الطبيب' },
  { key: 'MANAGE_WORK_EXCEPTIONS', group: 'Scheduling', desc: 'طلب استثناء عمل في يوم عطلة' },
  { key: 'APPROVE_WORK_EXCEPTIONS', group: 'Scheduling', desc: 'اعتماد وإلغاء استثناءات العمل' },
  { key: 'VIEW_SCHEDULE_IMPACT', group: 'Scheduling', desc: 'معاينة أثر تغييرات التقويم على المواعيد القائمة' },
  // جدول عمل الأطباء: الترحيل 054 ينشئ هذه المفاتيح ويربطها بالأدوار،
  // لكن قائمة PERMISSIONS في البذر لم تُحدَّث فكانت البذر الجديد يفتقدها.
  // تُضاف هنا لتكون قائمة الصلاحيات مكتملة وموحَّدة مع الترحيلات.
  { key: 'MANAGE_DOCTOR_SCHEDULES', group: 'Scheduling', desc: ' Minor وتعديل وحذف جدول عمل الأطباء' },
  { key: 'VIEW_DOCTOR_SCHEDULES', group: 'Scheduling', desc: 'عرض جدول عمل الأطباء والavailability' },
]

// إصدار مزامنة منح الأدوار. يُرفع عند إضافة مفاتيح صلاحيات جديدة ليدرجها
// البذر في الأدوار القائمة. الحلقة تُنفَّذ مرة واحدة لكل إصدار: بعد ذلك
// يبقى التخصيص عبر واجهة إدارة الصلاحيات هو مصدر الحقيقة.
const ROLE_PERMISSION_SYNC_VERSION = '2';


const ROLES = [
  { name: 'SUPER_ADMIN', desc: 'مدير النظام مع كافة الصلاحيات' },
  { name: 'SYSTEM_ADMIN', desc: 'مدير نظام (إدارة كاملة للعيادات والمستخدمين)' },
  { name: 'DOCTOR', desc: 'طبيب العيادة (المواعيد، الروشتات، ومرضى عيادته والمشتركين)' },
  { name: 'NURSE', desc: 'ممرض/ممرضة العيادة (متابعة المرضى والمواعيد)' },
  { name: 'ACCOUNTANT', desc: 'المحاسب (الشؤون المالية والتقارير حصرياً)' },
  { name: 'RECEPTIONIST', desc: 'موظف الاستقبال (تسجيل المرضى والزيارات والمواعيد)' },
  { name: 'PHARMACIST', desc: 'صيدلي (إدارة طابور الصيدلية وصرف الأدوية)' },
  { name: 'FINANCIAL_AUDITOR', desc: 'مدقق مالي (قراءة فقط للفواتير والتقارير المالية والتدقيق)' },
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  DOCTOR: ['VIEW_PATIENTS', 'EDIT_PATIENT_MEDICAL', 'CREATE_VISIT', 'VIEW_APPOINTMENTS', 'MANAGE_APPOINTMENTS', 'CREATE_PRESCRIPTION', 'VIEW_PRESCRIPTIONS', 'VIEW_MEDICATIONS', 'MANAGE_PREGNANCY', 'GENERATE_EMERGENCY_REPORT', 'VIEW_SHARED_PATIENT_RECORDS',
    // الجدولة: الطبيب يقرأ التقويم والأثر، ويطلب إجازة لنفسه (لا يعتمدها).
    'VIEW_HOLIDAYS', 'VIEW_DOCTOR_LEAVE', 'VIEW_SCHEDULE_IMPACT', 'MANAGE_DOCTOR_LEAVE', 'VIEW_DOCTOR_SCHEDULES'],
  NURSE: ['VIEW_PATIENTS', 'CREATE_VISIT', 'VIEW_APPOINTMENTS', 'VIEW_SHARED_PATIENT_RECORDS', 'MANAGE_PREGNANCY'],
  // المحاسب يسجّل الدفعات والاستردادات — وهو دور يكتب المال. المدقق المالي يقرأ ولا يُمنح هذه الصلاحيات.
  ACCOUNTANT: ['VIEW_PATIENTS', 'MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'RECORD_PAYMENT', 'RECORD_REFUND', 'CREATE_EXPENSE', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS'],
  RECEPTIONIST: ['VIEW_PATIENTS', 'CREATE_PATIENT', 'CREATE_VISIT', 'VIEW_APPOINTMENTS', 'MANAGE_APPOINTMENTS', 'VIEW_SHARED_PATIENT_RECORDS',
    // الجدولة: الاستقبال يقترح العطل والاستثناءات والإجازات، ولا يعتمد أياً منها.
    'VIEW_HOLIDAYS', 'VIEW_DOCTOR_LEAVE', 'VIEW_SCHEDULE_IMPACT', 'MANAGE_HOLIDAYS', 'MANAGE_DOCTOR_LEAVE', 'MANAGE_WORK_EXCEPTIONS',
    'VIEW_DOCTOR_SCHEDULES', 'MANAGE_DOCTOR_SCHEDULES'],
  PHARMACIST: ['VIEW_PRESCRIPTIONS', 'VIEW_PHARMACY_QUEUE', 'DISPENSE_MEDICATIONS', 'MANAGE_INVENTORY', 'MANAGE_SUPPLIERS', 'VIEW_INVENTORY', 'RECORD_PRESCRIPTION_FULFILMENT'],
  FINANCIAL_AUDITOR: ['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS'],
};

const seedDatabase = async () => {
  const client = await pool.connect();
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;

  if (!adminUsername || !adminPassword) {
    throw new Error('ADMIN_USERNAME and ADMIN_INITIAL_PASSWORD are required');
  }

  try {
    console.log('🌱 بدء زرع البيانات الأولية (Seeding)...');
    // الحسابات التجريبية (Demo) بكلمات مرور ثابتة مخصصة للتطوير فقط — لا تُنشأ أبداً في الإنتاج
    const isProduction = process.env.NODE_ENV === 'production';
    await client.query('BEGIN');

    // 1. إضافة الصلاحيات
    console.log('1. تعبئة الصلاحيات (Permissions)...');
    for (const perm of PERMISSIONS) {
      await client.query(
        `INSERT INTO permissions (permission_key, permission_group, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (permission_key) DO UPDATE 
         SET description = EXCLUDED.description, permission_group = EXCLUDED.permission_group;`,
        [perm.key, perm.group, perm.desc]
      );
    }

    // 2. إضافة الأدوار
    console.log('2. تعبئة الأدوار (Roles)...');
    for (const role of ROLES) {
      await client.query(
        `INSERT INTO roles (role_name, description)
         VALUES ($1, $2)
         ON CONFLICT (role_name) DO NOTHING;`,
        [role.name, role.desc]
      );
    }

    // 3. ربط أدوار الإدارة (SUPER_ADMIN و SYSTEM_ADMIN) بكافة الصلاحيات الموجودة
    console.log('3. منح كافة الصلاحيات لأدوار الإدارة...');
    // role_name مختار صراحةً: شرط استثناء DELETE_USERS أدناه يقرأ roleName،
    // وبلا هذا العمود كان الشرط غير مُفعَّل فعلياً ومنح SYSTEM_ADMIN حذف المستخدمين.
    const adminRoles = await client.query(`SELECT role_id, role_name FROM roles WHERE role_name IN ('SUPER_ADMIN', 'SYSTEM_ADMIN')`);

    const allPermissions = await client.query(`SELECT permission_id, permission_key FROM permissions`);
    for (const roleRow of adminRoles.rows) {
      for (const pRow of allPermissions.rows) {
        // حذف المستخدمين متاح لأعلى دور إداري فقط — لا يُمنح تلقائياً لـ SYSTEM_ADMIN
        if (pRow.permission_key === 'DELETE_USERS' && roleRow.role_name !== 'SUPER_ADMIN') continue;
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING;`,
          [roleRow.role_id, pRow.permission_id]
        );
      }
    }

    // مزامنة صلاحيات الأدوار غير الإدارية.
    //
    // المشكلة التي صُحّحت (R9): الشرط القديم كان "المزامنة لمرة واحدة فقط إذا
    // كان الدور بلا أي صلاحية". لكن الترحيلات نفسها تمنح بعض الصلاحيات للأدوار
    // (054/058)، فأي دور كان قد نال صلاحية واحدة من ترحيل كان يتخطّى قائمة
    // صلاحياته الأساسية بالكامل — في بذر جديد كان الطبيب بلا VIEW_PATIENTS.
    //
    // الحل: المزامنة صارت تُدفع بإصدار (ROLE_PERMISSION_SYNC_VERSION) وتُنفَّذ
    // مرة واحدة لكل إصدار، وتكون **إضافة فقط** (ON CONFLICT DO NOTHING): تُدرج
    // المفاتيح الناقصة ولا يُحذف أي تخصيص. بعد تنفيذ الإصدار الحالي يبقى
    // التخصيص عبر واجهة إدارة الصلاحيات هو مصدر الحقيقة.
    const syncMarker = await client.query(
      `SELECT value FROM system_settings WHERE key = 'seed.role_permissions.version'`
    );
    const appliedVersion = syncMarker.rows[0]?.value ?? null;

    if (appliedVersion !== ROLE_PERMISSION_SYNC_VERSION) {
      for (const [roleName, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
        const roleResult = await client.query('SELECT role_id FROM roles WHERE role_name = $1', [roleName]);
        const roleId = roleResult.rows[0]?.role_id;
        if (!roleId) continue;
        for (const permissionKey of permissionKeys) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT $1, permission_id FROM permissions WHERE permission_key = $2
             ON CONFLICT DO NOTHING`,
            [roleId, permissionKey]
          );
        }
      }
      await client.query(
        `INSERT INTO system_settings (key, value, description)
         VALUES ('seed.role_permissions.version', $1, 'Version of the role-permission grant list applied by the seed')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [ROLE_PERMISSION_SYNC_VERSION]
      );
    }

    // 4. إنشاء العيادة الرئيسية الأولى
    console.log('4. إنشاء العيادة الأولى...');
    const clinicResult = await client.query(
      `INSERT INTO clinics (clinic_name)
       SELECT 'العيادة الرئيسية'
       WHERE NOT EXISTS (SELECT 1 FROM clinics WHERE clinic_name = 'العيادة الرئيسية')
       RETURNING clinic_id;`
    );
    const existingClinic = await client.query(
      `SELECT clinic_id FROM clinics WHERE clinic_name = 'العيادة الرئيسية' ORDER BY clinic_id LIMIT 1`
    );
    const defaultClinicId = clinicResult.rows[0]?.clinic_id || existingClinic.rows[0]?.clinic_id || 1;

    // 5. إنشاء حساب SUPER_ADMIN الرئيسي
    console.log('5. إنشاء حساب الأدمن الرئيسي...');
    const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
    
    const superAdminRole = await client.query(`SELECT role_id FROM roles WHERE role_name = 'SUPER_ADMIN'`);

    await client.query(
      `INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO NOTHING;`,
      [superAdminRole.rows[0].role_id, defaultClinicId, 'Super Admin', adminUsername, adminPasswordHash, 'ACTIVE']
    );


    if (!isProduction) {
    // 6. إنشاء أطباء تجريبيين للعيادة
    console.log('6. إنشاء أطباء تجريبيين...');
    const doctorRole = await client.query('SELECT role_id FROM roles WHERE role_name = \'DOCTOR\'');
    const doctorPasswordHash = await bcrypt.hash('doctor123', 12);

    const doctors = [
      { name: 'د. أحمد محمد', username: 'ahmed', specialty: 'طب باطنية' },
      { name: 'د. فاطمة علي', username: 'fatima', specialty: 'طب أطفال' },
      { name: 'د. محمود حسن', username: 'mahmoud', specialty: 'جراحة عامة' },
      { name: 'د. سارة خالد', username: 'sara', specialty: 'نسائية وتوليد' },
    ];

    for (const doc of doctors) {
      await client.query(
        'INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, sub_specialty, status) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (username) DO NOTHING;',
        [doctorRole.rows[0].role_id, defaultClinicId, doc.name, doc.username, doctorPasswordHash, doc.specialty, 'ACTIVE']
      );
    }

    // 7. إنشاء ممرضات تجريبيات
    console.log('7. إنشاء ممرضات تجريبيات...');
    const nurseRole = await client.query('SELECT role_id FROM roles WHERE role_name = \'NURSE\'');
    const nursePasswordHash = await bcrypt.hash('nurse123', 12);

    const nurses = [
      { name: 'نورة أحمد', username: 'noura' },
      { name: 'ليلى محمود', username: 'layla' },
    ];

    for (const nurse of nurses) {
      await client.query(
        'INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (username) DO NOTHING;',
        [nurseRole.rows[0].role_id, defaultClinicId, nurse.name, nurse.username, nursePasswordHash, 'ACTIVE']
      );
    }

    // 8. إنشاء موظفي استقبال تجريبيين
    console.log('8. إنشاء موظفي استقبال تجريبيين...');
    const receptionistRole = await client.query('SELECT role_id FROM roles WHERE role_name = \'RECEPTIONIST\'');
    const receptionistPasswordHash = await bcrypt.hash('reception123', 12);

    const receptionists = [
      { name: 'محمد علي', username: 'mohamed' },
    ];

    for (const rec of receptionists) {
      await client.query(
        'INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (username) DO NOTHING;',
        [receptionistRole.rows[0].role_id, defaultClinicId, rec.name, rec.username, receptionistPasswordHash, 'ACTIVE']
      );
    }
    } // نهاية كتلة الحسابات التجريبية — تُنشأ في التطوير فقط
    await client.query('COMMIT');
    console.log('✅ تم إكمال زرع البيانات بنجاح!');
    console.log('------------------------------------');
    console.log('Initial administrator account created or preserved.');
    console.log('------------------------------------');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ حدث خطأ أثناء زرع البيانات:', error);
  } finally {
    client.release();
    process.exit(0);
  }
};

seedDatabase();