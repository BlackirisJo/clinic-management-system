import { Request, Response } from 'express';
import { pool } from '../config/database';
import { createPatientSchema } from '../validations/patient.validation';

export const createPatient = async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = createPatientSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ errors: parseResult.error.flatten().fieldErrors });
      return;
    }

    const { fullName, gender, dateOfBirth, phone, email, address, medicalHistory } = parseResult.data;
    const clinicId = (req as any).user?.clinicId || 1;

    const result = await pool.query(
      `INSERT INTO patients (clinic_id, full_name, gender, date_of_birth, phone, email, address, medical_history)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [clinicId, fullName, gender, dateOfBirth || null, phone, email || null, address || null, medicalHistory || null]
    );

    res.status(201).json({
      message: 'تم إضافة المريض بنجاح',
      patient: result.rows[0],
    });
  } catch (error) {
    console.error('Error in createPatient:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة المريض' });
  }
};

export const getPatients = async (req: Request, res: Response): Promise<void> => {
  try {
    const clinicId = (req as any).user?.clinicId || 1;
    const search = (req.query.search as string) || '';

    const query = `
      SELECT * FROM patients 
      WHERE clinic_id = $1 AND (full_name ILIKE $2 OR phone ILIKE $2)
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [clinicId, `%${search}%`]);

    res.status(200).json({
      patients: result.rows,
    });
  } catch (error) {
    console.error('Error in getPatients:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب قائمة المرضى' });
  }
};