import { Router } from 'express';
import {
  listPermissionOptions,
  listRoles,
  createRole,
  updateRole,
  setRolePermissions,
  updateRoleStatus,
  deleteRole,
} from './permissions.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { validateBody } from '../../middlewares/validate.middleware';
import {
  createRoleSchema,
  updateRoleSchema,
  setRolePermissionsSchema,
  updateRoleStatusSchema,
} from './permissions.validation';

const router = Router();

// إدارة الأدوار والصلاحيات — متاحة فقط لمن يملك صلاحية MANAGE_PERMISSIONS
// (التحقق الحقيقي يتم في Backend — الواجهة تخفي الرابط لتحسين UX فقط)
router.use(authenticateJWT, requirePermission('MANAGE_PERMISSIONS'));

// قوائم العرض
router.get('/', listPermissionOptions);
router.get('/options', listPermissionOptions);
router.get('/roles', listRoles);

// إدارة الأدوار
router.post('/roles', validateBody(createRoleSchema), createRole);
router.put('/roles/:roleId', validateBody(updateRoleSchema), updateRole);
router.put('/roles/:roleId/permissions', validateBody(setRolePermissionsSchema), setRolePermissions);
router.patch('/roles/:roleId/status', validateBody(updateRoleStatusSchema), updateRoleStatus);
router.delete('/roles/:roleId', deleteRole);

export default router;