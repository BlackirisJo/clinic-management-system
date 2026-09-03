-- ==============================================================================
-- Migration / Update Script: 002_update_backups_schema.sql
-- Description: Align backup table with Node.js service & add encryption fields
-- ==============================================================================

-- 1. تعديل أو إعادة إنشاء جدول سجلات النسخ الاحتياطي ليتوافق مع كود Node.js
CREATE TABLE IF NOT EXISTS backup_logs (
    backup_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    checksum VARCHAR(255) NOT NULL,
    iv VARCHAR(255),
    auth_tag VARCHAR(255),
    status VARCHAR(50) DEFAULT 'IN_PROGRESS',
    created_by_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. في حال كان جدول database_backups قد تم إنشاؤه سابقاً، يضاف إليه حقول التشفير للتوافق:
ALTER TABLE IF EXISTS database_backups 
ADD COLUMN IF NOT EXISTS iv VARCHAR(255),
ADD COLUMN IF NOT EXISTS auth_tag VARCHAR(255);