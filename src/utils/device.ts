// وصف مختصر للجهاز/المتصفح من ترويسة User-Agent — تحليل نصي بسيط بالتعبيرات
// النمطية فقط، لعرضه في قائمة جلسات المستخدم (بلا fingerprinting ولا مكتبات).
export const parseDeviceLabel = (userAgent?: string | null): string => {
  if (!userAgent) return 'جهاز غير معروف';
  const ua = userAgent;

  let browser = 'متصفح غير معروف';
  if (/edg(?:e|a|ios)?\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua)) browser = 'Safari';

  let os = 'نظام غير معروف';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone/i.test(ua)) os = 'iPhone';
  else if (/ipad/i.test(ua)) os = 'iPad';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return `${browser} — ${os}`;
};
