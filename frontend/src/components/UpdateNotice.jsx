import { useRegisterSW } from 'virtual:pwa-register/react'
import { useT } from '../i18n'

// فحص التحديثات مرة واحدة كل ساعة مع الإبقاء على نسخة واحدة فقط من المؤقّت
let updateTimer = null

// إشعار تحديث التطبيق: لا نُجبر المستخدم على إعادة التثبيت، ولا نستبدل
// الجلسة أو الواجهة تحت يديه — نعرض خيار إعادة التحميل فقط.
export default function UpdateNotice() {
  const t = useT()
  const sw = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration || updateTimer) return
      updateTimer = setInterval(() => { registration.update?.() }, 60 * 60 * 1000)
    },
  })

  const needRefresh = Boolean(sw?.needRefresh?.[0])
  const setNeedRefresh = sw?.needRefresh?.[1]
  const updateServiceWorker = sw?.updateServiceWorker

  if (!needRefresh || typeof updateServiceWorker !== 'function') return null

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <p>{t('update.available')}</p>
      <button type="button" className="primary-button compact" onClick={() => updateServiceWorker(true)}>
        {t('update.reload')}
      </button>
      <button type="button" className="secondary-button compact" onClick={() => setNeedRefresh?.(false)}>
        {t('update.later')}
      </button>
    </div>
  )
}