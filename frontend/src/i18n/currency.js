// Base currency cache — shared between formatter and hooks
// Loaded once from /api/settings; defaults to JOD for backward compatibility
let _baseCurrency = 'JOD';

export function setBaseCurrency(code) {
  if (code && typeof code === 'string') _baseCurrency = code.toUpperCase();
}

export function getBaseCurrency() {
  return _baseCurrency;
}
