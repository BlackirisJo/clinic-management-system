import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { comparePassword, generateToken, hashPassword } from '../../utils/auth';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';

export const login = async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ message: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  try {
    const userQuery = await pool.query(
      'SELECT user_id, role_id, clinic_id, password_hash, status FROM users WHERE username = $1',
      [username]
    );

    if (userQuery.rows.length === 0) {
      await pool.query(`INSERT INTO audit_logs (action, resource_type, metadata) VALUES ('LOGIN_FAILURE', 'AUTH', $1)`, [JSON.stringify({ username, ip: req.ip })]);
      return res.status(401).json({ message: 'اسم المستخدم أو كلمة السر غير صحيحة' });
    }

    const user = userQuery.rows[0];

    if (user.status !== 'ACTIVE') {
      await pool.query(`INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, metadata) VALUES ($1, $2, 'LOGIN_BLOCKED', 'AUTH', $3)`, [user.user_id, user.clinic_id, JSON.stringify({ ip: req.ip })]);
      return res.status(403).json({ message: 'الحساب غير فعال أو معطل' });
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
      await pool.query(`INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, metadata) VALUES ($1, $2, 'LOGIN_FAILURE', 'AUTH', $3)`, [user.user_id, user.clinic_id, JSON.stringify({ ip: req.ip })]);
      return res.status(401).json({ message: 'اسم المستخدم أو كلمة السر غير صحيحة' });
    }

    const token = generateToken({
      userId: user.user_id,
      roleId: user.role_id,
      clinicId: user.clinic_id,
    });
    const tokenPayload = jwt.decode(token) as { jti?: string; exp?: number } | null;
    if (tokenPayload?.jti && tokenPayload.exp) {
      // وصف الجهاز من ترويسة الطلب (نص خام مقتطع — بلا fingerprinting)
      const uaHeader = req.headers['user-agent'];
      const userAgent = typeof uaHeader === 'string' ? uaHeader.slice(0, 512) : null;
      // كل تسجيل دخول = جلسة مستقلة، تبدأ بحضور (last_seen_at) من لحظة الإنشاء
      await pool.query(
        `INSERT INTO user_sessions (user_id, jti, expires_at, last_seen_at, user_agent)
         VALUES ($1, $2, to_timestamp($3), NOW(), $4)`,
        [user.user_id, tokenPayload.jti, tokenPayload.exp, userAgent]
      );
    }
    await pool.query(`INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, metadata) VALUES ($1, $2, 'LOGIN_SUCCESS', 'AUTH', $3)`, [user.user_id, user.clinic_id, JSON.stringify({ ip: req.ip })]);

    return res.status(200).json({
      message: 'تم تسجيل الدخول بنجاح',
      token,
    });
  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
};

export const logout = async (req: AuthenticatedRequest, res: Response) => {
  const jti = req.authToken?.jti;
  if (jti) await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE jti = $1', [jti]);
  return res.status(200).json({ message: 'تم إنهاء الجلسة بنجاح' });
};

export const logoutAll = async (req: AuthenticatedRequest, res: Response) => {
  await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [req.user?.userId]);
  return res.status(200).json({ message: 'تم إنهاء جميع الجلسات بنجاح' });
};

// نبضة القلب (Heartbeat): تحديث last_seen_at للجلسة الحالية المستخرجة من JWT.
// لا يُقبل أي معرف جلسة/مستخدم من الواجهة — المصدر هو التوكن الموثق عبر authenticateJWT
// (الذي يضمن أصلًا: جلسة موجودة وغير ملغاة وغير منتهية ومستخدم ACTIVE).
export const heartbeat = async (req: AuthenticatedRequest, res: Response) => {
  const jti = req.authToken?.jti;
  const userId = req.user?.userId;
  if (!jti || !userId) return res.status(401).json({ message: 'المستخدم غير موثق' });

  try {
    // شرط دفاعي إضافي (جلسة غير ملغاة وغير منتهية) لحماية من أي تغير حالي بين الوسيط والمعالج
    const result = await pool.query(
      `UPDATE user_sessions SET last_seen_at = NOW()
       WHERE jti = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW()
       RETURNING session_id`,
      [jti, userId]
    );
    if (!result.rowCount) {
      return res.status(403).json({ message: 'انتهت صلاحية جلستك أو تم إنهاؤها من قبل مدير النظام', code: 'SESSION_REVOKED' });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Heartbeat Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
};

// تغيير كلمة المرور (يتطلب كلمة المرور الحالية) — يُصفّر is_force_password_change
// ويُلغي بقية الجلسات النشطة كإجراء أمني.
export const changePassword = async (req: AuthenticatedRequest, res: Response) => {
  const { current_password, new_password } = req.body;
  const userId = req.user?.userId;

  if (typeof current_password !== 'string' || !current_password) {
    return res.status(400).json({ message: 'كلمة المرور الحالية مطلوبة' });
  }
  if (typeof new_password !== 'string' || new_password.length < 12 || new_password.length > 128) {
    return res.status(400).json({ message: 'كلمة المرور الجديدة يجب أن تكون بين 12 و 128 حرفاً' });
  }
  if (new_password === current_password) {
    return res.status(400).json({ message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية' });
  }

  try {
    const userResult = await pool.query(
      'SELECT password_hash, status, username FROM users WHERE user_id = $1',
      [userId]
    );
    if (!userResult.rowCount) return res.status(404).json({ message: 'المستخدم غير موجود' });
    const user = userResult.rows[0];
    if (user.status !== 'ACTIVE') return res.status(403).json({ message: 'الحساب غير فعال' });

    const isCurrentValid = await comparePassword(current_password, user.password_hash);
    if (!isCurrentValid) {
      await pool.query(
        `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, metadata)
         VALUES ($1, $2, 'PASSWORD_CHANGE_FAILED', 'AUTH', $3)`,
        [userId, req.user?.clinicId, JSON.stringify({ ip: req.ip })]
      );
      return res.status(400).json({ message: 'كلمة المرور الحالية غير صحيحة' });
    }

    const newHash = await hashPassword(new_password);
    await pool.query(
      `UPDATE users SET password_hash = $1, is_force_password_change = FALSE, updated_at = NOW() WHERE user_id = $2`,
      [newHash, userId]
    );
    // إلغاء جميع الجلسات الأخرى (تبقى الجلسة الحالية ليتابع المستخدم عمله)
    await pool.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL AND jti <> $2`,
      [userId, req.authToken?.jti]
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'PASSWORD_CHANGED', 'AUTH', $3)`,
      [userId, req.user?.clinicId, userId]
    );
    return res.status(200).json({ message: 'تم تغيير كلمة المرور بنجاح' });
  } catch (error) {
    console.error('Change Password Error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم أثناء تغيير كلمة المرور' });
  }
};