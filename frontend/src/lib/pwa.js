// أدوات PWA مساعدة — كشف الوضع المستقل، التقاط طلب التثبيت، وتعليمات iOS.
// ملاحظة أمنية: لا تُخزَّن هنا أي بيانات مرضى أو توكنات؛ فقط تفضيل المستخدم
// بشأن إخفاء دعوة التثبيت (localStorage).

export const INSTALL_UI_EVENT = 'nabd:show-install'

const DISMISS_KEY = 'nabd_install_prompt_dismissed_at'
const DISMISS_DAYS = 30

// الحدث يُلتقط مرة واحدة ويُحفظ لإظهار التثبيت في الوقت المناسب (لا نستدعي prompt مباشرة)
let deferredPrompt = null
const listeners = new Set()

const notify = () => listeners.forEach((fn) => { try { fn(Boolean(deferredPrompt)) } catch { /* تجاهل */ } })

export const onInstallAvailabilityChange = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// هل التطبيق يعمل كمثبّت (Standalone)؟
export const isStandalone = () => {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
    if (window.matchMedia?.('(display-mode: minimal-ui)').matches) return true
    if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true
  } catch { /* متصفح لا يدعم matchMedia */ }
  // iOS/iPadOS القديم يعرّف الخاصية التالية بدل display-mode
  return window.navigator?.standalone === true
}

// iPhone / iPad / iPod — بما في ذلك iPadOS 13+ التي تُعرّف نفسها كـ Mac
export const isIosDevice = () => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1
}

// متصفح Safari الحقيقي (لا Chrome/Edge/Firefox على iOS)
export const isSafariBrowser = () => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua)
}

export const canPromptInstall = () => Boolean(deferredPrompt)

// عرض طلب التثبيت الأصلي (Android/Chrome/Edge/Desktop)
export const promptInstall = async () => {
  if (!deferredPrompt) return 'unavailable'
  const event = deferredPrompt
  deferredPrompt = null
  notify()
  try {
    event.prompt()
    const choice = await event.userChoice
    return choice?.outcome || 'dismissed'
  } catch {
    return 'failed'
  }
}

// تذكّر رفض المستخدم حتى لا تتكرر الدعوة في كل زيارة
export const rememberInstallDismiss = () => {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* التخزين معطّل */ }
}

export const isInstallDismissedRecently = () => {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    const at = Number(raw)
    if (!Number.isFinite(at)) return false
    return Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

export const clearInstallDismiss = () => {
  try { localStorage.removeItem(DISMISS_KEY) } catch { /* التخزين معطّل */ }
}

// طلب إظهار واجهة التثبيت يدوياً (من قائمة التطبيق)
export const requestInstallUi = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(INSTALL_UI_EVENT))
}

// يُستدعى مرة واحدة عند بدء التطبيق
export const setupPwaListeners = () => {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()      // لا نعرض الدعوة تلقائياً — نحتفظ بالحدث لعرضه في وقته
    deferredPrompt = event
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    clearInstallDismiss()
    notify()
  })
}