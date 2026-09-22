import { Router } from 'express';
import { list, exportCSV, exportExcel } from './audit.controller';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';

const router = Router();

router.use(authenticateJWT);

router.get('/logs', list);
router.get('/logs/export/csv', exportCSV);
router.get('/logs/export/excel', exportExcel);

export default router;