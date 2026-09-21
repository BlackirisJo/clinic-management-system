-- صلاحية إنشاء تقرير طبي طارئ
INSERT INTO permissions (permission_key, permission_group, description) VALUES
    ('GENERATE_EMERGENCY_REPORT', 'Clinical', 'إنشاء تقرير طبي طارئ للعيادة')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r, permissions p
WHERE r.role_name = 'DOCTOR' AND p.permission_key = 'GENERATE_EMERGENCY_REPORT'
ON CONFLICT DO NOTHING;
