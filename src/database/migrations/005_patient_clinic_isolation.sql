ALTER TABLE patients ADD COLUMN IF NOT EXISTS clinic_id INT REFERENCES clinics(clinic_id) ON DELETE CASCADE;

UPDATE patients
SET clinic_id = (SELECT clinic_id FROM clinics ORDER BY clinic_id LIMIT 1)
WHERE clinic_id IS NULL;

ALTER TABLE patients ALTER COLUMN clinic_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patients_clinic_id ON patients (clinic_id);
CREATE INDEX IF NOT EXISTS idx_visits_clinic_patient ON visits (clinic_id, patient_id);