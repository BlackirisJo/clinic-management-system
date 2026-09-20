import { Router } from 'express';
import { authenticateJWT, requirePermission } from '../../middlewares/auth.middleware';
import { getSettings, validateCurrency } from './settings.controller';

const router = Router();

router.use(authenticateJWT);

router.get('/', requirePermission('VIEW_REPORTS'), getSettings);
router.get('/validate-currency/:code', requirePermission('VIEW_REPORTS'), validateCurrency);

export default router;
