import { Router } from 'express';
import { list } from './audit.controller';
import { authenticateJWT } from '../../middlewares/auth.middleware';

const router = Router();

router.use(authenticateJWT);

router.get('/logs', list);

export default router;