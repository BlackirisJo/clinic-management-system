import { Pool, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// مهم: أعمدة DATE (نوع pg 1082) تُرجع كنص خالص YYYY-MM-DD بدل كائن Date يتحول حسب منطقة
// الخادم الزمنية (كان يسبب إزاحة يوماً واحداً في الصيغ المرسلة للواجهة مثل appointment_date/edd_date).
types.setTypeParser(1082, (value: string) => value);

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

pool.on('connect', () => {
  console.log('PostgreSQL Database connected successfully');
});