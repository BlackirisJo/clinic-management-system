import { Response } from 'express';
import { getBaseCurrency, isValidCurrencyCode } from '../currencies/currency.validation';

export const getSettings = async (_req: unknown, res: Response) => {
  try {
    const baseCurrency = await getBaseCurrency();
    return res.status(200).json({ base_currency: baseCurrency });
  } catch (error) {
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب الإعدادات' });
  }
};

export const validateCurrency = async (req: unknown, res: Response) => {
  const code = (req as any).params?.code;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ message: 'رمز العملة مطلوب' });
  }
  const valid = isValidCurrencyCode(code);
  return res.status(200).json({ code: code.toUpperCase(), valid });
};
