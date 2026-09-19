import { useEffect, useState } from 'react'
import { Modal } from './ui'
import { useT } from '../i18n'
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
  const t = useT()
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
        <div className="install-bar" role="dialog" aria-label={t("install.promptTitle")}>
          <div className="install-bar-icon" aria-hidden="true">ن</div>
          <div className="install-bar-text">
            <strong>{t('install.promptTitle')}</strong>
            <span>{t('install.promptText')}</span>
          </div>
          <div className="install-bar-actions">
            <button type="button" className="primary-button compact" disabled={busy} onClick={install}>
              {busy ? t('install.installing') : t('install.installBtn')}
            </button>
            <button type="button" className="secondary-button compact" onClick={later}>{t('install.later')}</button>
          </div>
        </div>
      )}

      {help && (
        <Modal title={t('install.promptTitle')} subtitle={t('install.deviceSubtitle')} onClose={() => setHelp(null)}>
          {help === 'ios' ? (
            <ol className="install-steps">
              <li><span className="install-step-icon" aria-hidden="true">1</span><div>{t('install.iosStep1')}</div></li>
              <li><span className="install-step-icon" aria-hidden="true">2</span><div>{t('install.iosStep2')}</div></li>
              <li><span className="install-step-icon" aria-hidden="true">3</span><div>{t('install.iosStep3')}</div></li>
              <li><span className="install-step-icon" aria-hidden="true">4</span><div>{t('install.iosStep4')}</div></li>
            </ol>
          ) : (
            <ol className="install-steps">
              <li><span className="install-step-icon" aria-hidden="true">1</span><div>{t('install.genericStep1')}</div></li>
              <li><span className="install-step-icon" aria-hidden="true">2</span><div>{t('install.genericStep2')}</div></li>
              <li><span className="install-step-icon" aria-hidden="true">3</span><div>{t('install.genericStep3')}</div></li>
            </ol>
          )}
          {help === 'ios' && !safari && (
            <p className="muted-small">{t('install.iosNote')}</p>
          )}
          <p className="muted-small">{t('install.privacyNote')}</p>
        </Modal>
      )}
    </>
  )
}