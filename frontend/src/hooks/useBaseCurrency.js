import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { setBaseCurrency, getBaseCurrency } from '../i18n/currency';

export function useBaseCurrency() {
  const [currency, setCurrency] = useState(getBaseCurrency());

  useEffect(() => {
    let cancelled = false;
    api.settings
      .get()
      .then((data) => {
        if (cancelled) return;
        const code = data?.base_currency;
        if (code) {
          setBaseCurrency(code);
          setCurrency(code);
        }
      })
      .catch(() => { /* استخدم القيمة الافتراضية JOD */ });
    return () => { cancelled = true };
  }, []);

  return currency;
}
