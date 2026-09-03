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
  
  // المالية والفواتير
  { key: 'MANAGE_SERVICES', group: 'Finance', desc: 'إدارة قائمة الخدمات وأسعارها' },
  { key: 'CREATE_INVOICE', group: 'Finance', desc: 'إصدار فواتير للخدمات والزيارات' },
  { key: 'VIEW_INVOICES', group: 'Finance', desc: 'عرض الفواتير والتقارير المالية' },
  { key: 'CREATE_EXPENSE', group: 'Finance', desc: 'تسجيل المصاريف التشغيلية' },
  { key: 'VIEW_FINANCIAL_REPORTS', group: 'Finance', desc: 'الاطلاع على الإحصائيات والأرباح' },
  { key: 'VIEW_REPORTS', group: 'Reports', desc: 'عرض التقارير الشاملة للنظام' },

  // النسخ الاحتياطي
  { key: 'MANAGE_BACKUPS', group: 'System', desc: 'إنشاء وتنزيل النسخ الاحتياطية' },
  { key: 'VIEW_BACKUP_LOGS', group: 'System', desc: 'عرض سجلات النسخ الاحتياطي' },
  { key: 'RESTORE_BACKUPS', group: 'System', desc: 'استرجاع النسخ الاحتياطية' },
];

const ROLES = [
  { name: 'SUPER_ADMIN', desc: 'مدير النظام مع كافة الصلاحيات' },
  { name: 'DOCTOR', desc: 'طبيب العيادة (المرضى، الزيارات، الروشتات)' },
  { name: 'ACCOUNTANT', desc: 'المحاسب (الفواتير، المصاريف، والتقارير)' },
  { name: 'RECEPTIONIST', desc: 'موظف الاستقبال (تسجيل المرضى والزيارات والفواتير)' },
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  DOCTOR: ['VIEW_PATIENTS', 'CREATE_VISIT', 'VIEW_APPOINTMENTS', 'MANAGE_APPOINTMENTS', 'CREATE_PRESCRIPTION', 'VIEW_PRESCRIPTIONS', 'VIEW_MEDICATIONS', 'VIEW_SHARED_PATIENT_RECORDS'],
  ACCOUNTANT: ['VIEW_PATIENTS', 'MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'CREATE_EXPENSE', 'VIEW_FINANCIAL_REPORTS', 'VIEW_REPORTS'],
  RECEPTIONIST: ['VIEW_PATIENTS', 'CREATE_PATIENT', 'CREATE_VISIT', 'VIEW_APPOINTMENTS', 'MANAGE_APPOINTMENTS', 'CREATE_INVOICE', 'VIEW_INVOICES', 'VIEW_SHARED_PATIENT_RECORDS'],
};

const seedDatabase = async () => {
  const client = await pool.connect();

  try {
    console.log('🌱 بدء زرع البيانات الأولية (Seeding)...');
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

    // 3. ربط دور SUPER_ADMIN بكافة الصلاحيات الموجودة
    console.log('3. منح كافة الصلاحيات لدور SUPER_ADMIN...');
    const superAdminRole = await client.query(`SELECT role_id FROM roles WHERE role_name = 'SUPER_ADMIN'`);
    const superAdminRoleId = superAdminRole.rows[0].role_id;

    const allPermissions = await client.query(`SELECT permission_id FROM permissions`);
    for (const pRow of allPermissions.rows) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING;`,
        [superAdminRoleId, pRow.permission_id]
      );
    }

    for (const [roleName, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
      const roleResult = await client.query('SELECT role_id FROM roles WHERE role_name = $1', [roleName]);
      for (const permissionKey of permissionKeys) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, permission_id FROM permissions WHERE permission_key = $2
           ON CONFLICT DO NOTHING`,
          [roleResult.rows[0]?.role_id, permissionKey]
        );
      }
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
    const adminPasswordHash = await bcrypt.hash('Admin@123456', 10);
    
    await client.query(
      `INSERT INTO users (role_id, clinic_id, full_name, username, password_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO NOTHING;`,
      [superAdminRoleId, defaultClinicId, 'Super Admin', 'admin', adminPasswordHash, 'ACTIVE']
    );

    await client.query('COMMIT');
    console.log('✅ تم إكمال زرع البيانات بنجاح!');
    console.log('------------------------------------');
    console.log('بيانات تسجيل الدخول للآدمن الرئيسي:');
    console.log('اسم المستخدم: admin');
    console.log('كلمة المرور: Admin@123456');
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