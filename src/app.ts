import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRoutes from './modules/auth/auth.routes';

dotenv.config();

const app: Application = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);

// Health Check Endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', message: 'Clinic API is running securely' });
});

export default app;