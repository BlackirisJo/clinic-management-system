import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { comparePassword, generateToken } from '../../utils/auth';
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
      await pool.query(
        `INSERT INTO user_sessions (user_id, jti, expires_at) VALUES ($1, $2, to_timestamp($3))`,
        [user.user_id, tokenPayload.jti, tokenPayload.exp]
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