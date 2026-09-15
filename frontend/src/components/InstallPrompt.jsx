import { useEffect, useState } from 'react'
import { Modal } from './ui'
import {
  INSTALL_UI_EVENT,
  canPromptInstall,
  clearInstallDismiss,
  isInstallDismissedRecently,
  isIosDevice,
  isSafariBrowser,
  isStandalone,
  promptInstall,
  rememberInstallDismiss,
} from '../lib/pwa'

// دعوة التثبيت: لا تظهر فوراً، ولا تتكرر بعد رفض المستخدم، ولا تظهر إطلاقاً
// داخل التطبيق المثبّت (Standalone). يمكن إعادة إظهارها من قائمة التطبيق.
const AUTO_SHOW_DELAY = 12000

export default function InstallPrompt() {
  const [visible, setVisible] = useState(false)
  const [help, setHelp] = useState(null)     // 'ios' | 'generic' | null
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState(() => isStandalone())

  const ios = isIosDevice()
  const safari = isSafariBrowser()

  // عرض الدعوة تلقائياً مرة واحدة وبمهلة، وبشرط عدم الرفض المسبق
  useEffect(() => {
    if (isStandalone() || isInstallDismissedRecently()) return undefined
    const timer = setTimeout(() => {
      if (isStandalone()) return
      if (canPromptInstall() || ios) setVisible(true)
    }, AUTO_SHOW_DELAY)
    return () => clearTimeout(timer)
  }, [ios])

  // إعادة الإظهار يدوياً من قائمة التطبيق
  useEffect(() => {
    const onRequest = () => {
      setInstalled(isStandalone())
      if (isStandalone()) { setHelp('generic'); return }
      clearInstallDismiss()
      if (canPromptInstall()) setVisible(true)
      else setHelp(ios ? 'ios' : 'generic')
    }
    window.addEventListener(INSTALL_UI_EVENT, onRequest)
    const onInstalled = () => { setInstalled(true); setVisible(false); setHelp(null) }
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener(INSTALL_UI_EVENT, onRequest)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [ios])

  if (installed) return null

  async function install() {
    if (!canPromptInstall()) { setHelp(ios ? 'ios' : 'generic'); return }
    setBusy(true)
    const outcome = await promptInstall()
    setBusy(false)
    if (outcome === 'accepted') { setVisible(false); return }
    if (outcome === 'dismissed') { rememberInstallDismiss(); setVisible(false) }
  }

  function later() {
    rememberInstallDismiss()
    setVisible(false)
  }

  return (
    <>
      {visible && (
        <div className="install-bar" role="dialog" aria-label="تثبيت التطبيق">
          <div className="install-bar-icon" aria-hidden="true">ن</div>
          <div className="install-bar-text">
            <strong>ثبّت تطبيق نبض</strong>
            <span>افتح النظام من الشاشة الرئيسية كتطبيق مستقل.</span>
          </div>
          <div className="install-bar-actions">
            <button type="button" className="primary-button compact" disabled={busy} onClick={install}>
              {busy ? 'جارِ التثبيت...' : 'تثبيت'}
            </button>
            <button type="button" className="secondary-button compact" onClick={later}>لاحقاً</button>
          </div>
        </div>
      )}

      {help && (
        <Modal title="تثبيت تطبيق نبض" subtitle="على هذا الجهاز" onClose={() => setHelp(null)}>
          {help === 'ios' ? (
            <ol className="install-steps">
              <li><span className="install-step-icon" aria-hidden="true">1</span><div>افتح النظام في متصفح <b>Safari</b> على الآيفون أو الآيباد.</div></li>
              <li><span className="install-step-icon" aria-hidden="true">2</span><div>اضغط زر <b>المشاركة</b> في شريط Safari (المربع مع السهم للأعلى).</div></li>
              <li><span className="install-step-icon" aria-hidden="true">3</span><div>اختر <b>إضافة إلى الشاشة الرئيسية</b>.</div></li>
              <li><span className="install-step-icon" aria-hidden="true">4</span><div>اضغط <b>إضافة</b> — سيظهر تطبيق نبض مع بقية تطبيقات الجهاز.</div></li>
            </ol>
          ) : (
            <ol className="install-steps">
              <li><span className="install-step-icon" aria-hidden="true">1</span><div>افتح قائمة المتصفح (النقاط الثلاث أو أيقونة التثبيت في شريط العنوان).</div></li>
              <li><span className="install-step-icon" aria-hidden="true">2</span><div>اختر <b>تثبيت التطبيق</b> أو <b>إضافة إلى الشاشة الرئيسية</b>.</div></li>
              <li><span className="install-step-icon" aria-hidden="true">3</span><div>أكّد التثبيت — سيعمل النظام بعدها في وضع مستقل بدون شريط المتصفح.</div></li>
            </ol>
          )}
          {help === 'ios' && !safari && (
            <p className="muted-small">ملاحظة: متصفحات iOS غير Safari لا تعرض خيار التثبيت — استخدم Safari للحصول على التجربة الكاملة.</p>
          )}
          <p className="muted-small">بيانات المرضى لا تُخزَّن على الجهاز — التثبيت يغيّر طريقة العرض فقط.</p>
        </Modal>
      )}
    </>
  )
}