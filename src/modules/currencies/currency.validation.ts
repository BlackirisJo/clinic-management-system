import { pool } from '../../config/database';

const CURRENCY_CODES = new Set(['JOD', 'USD', 'EUR', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR']);

export function isValidCurrencyCode(code: string): boolean {
  return CURRENCY_CODES.has(code.toUpperCase());
}

export async function getBaseCurrency(): Promise<string> {
  const result = await pool.query("SELECT value FROM system_settings WHERE key = 'base_currency'");
  if (result.rowCount && result.rows[0]?.value) {
    return result.rows[0].value;
  }
  return 'JOD';
}
