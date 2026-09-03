ALTER TABLE patients ADD CONSTRAINT patients_clinic_patient_unique UNIQUE (clinic_id, patient_id);
ALTER TABLE visits ADD CONSTRAINT visits_patient_clinic_fk
    FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, patient_id);