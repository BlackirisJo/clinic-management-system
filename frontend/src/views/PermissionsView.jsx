import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useAuth, hasPermission } from '../auth/AuthContext'
import { useT } from '../i18n'
import { ROLE_LABELS } from '../lib/format'

// صفحة إدارة الصلاحيات (المرحلة 3) — إدارة الأدوار والصلاحيات من داخل النظام بدون تعديل الكود
// الظهور مشروط بصلاحية MANAGE_PERMISSIONS، والحماية الحقيقية والنهائية في الخادم
export default function PermissionsView() {
  const { user } = useAuth()
  const t = useT()
  const [groups, setGroups] = useState([])
  const [roles, setRoles] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [selected, setSelected] = useState([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleDesc, setNewRoleDesc] = useState('')
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const flash = (msg, isError = false) => {
    setError(isError ? msg : null)
    setMessage(isError ? null : msg)
  }

  const load = useCallback(async (keepId) => {
    setBusy(true)
    try {
      const [opt, rls] = await Promise.all([api.permissions.options(), api.permissions.roles()])
      setGroups(opt.groups || [])
      const list = rls.roles || []
      setRoles(list)
      setSelectedId((cur) => {
        const want = keepId ?? cur
        return want && list.some((r) => r.role_id === want) ? want : (list[0]?.role_id ?? null)
      })
    } catch (e) {
      flash(e.message, true)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const role = useMemo(() => roles.find((r) => r.role_id === selectedId) || null, [roles, selectedId])

  // المفتاح الذي يعكس صلاحيات الخادم للدور المحدد — نزامن النموذج مع الخادم
  // فقط عندما يختلف عن ما يعرضه النموذج (تحميل جديد / تبديل دور / حفظ ناجح)،
  // أما نقرات المستخدم المحلية فلا تُمسح لأنها تحدّث selected فوراً.
  useEffect(() => {
  if (!role) {
    setSelected([])
    setName('')
    setDescription('')
    return
  }

  setSelected(Array.isArray(role.permissions) ? [...role.permissions] : [])
  setName(role.role_name || '')
  setDescription(role.description || '')
}, [selectedId])

  const isProtected = role?.role_name === 'SUPER_ADMIN';
  const isSystem = Boolean(role?.is_system);
  const canManage = hasPermission(user, 'MANAGE_PERMISSIONS');
  const isNonSystemAdmin = role && role.role_name !== 'SYSTEM_ADMIN' && role.role_name !== 'SUPER_ADMIN';

  const toggle = (key) =>
    setSelected((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))

const savePermissions = async () => {
  if (!role) return

  setBusy(true)
  setError(null)
  setMessage(null)

  try {
    const permission_keys = [...new Set(selected)]

    await api.permissions.setRolePermissions(role.role_id, {
      permission_keys,
    })

    // مصدر الحقيقة الوحيد بعد الحفظ هو قاعدة البيانات.
    // لا نعتمد على الحالة المحلية أو على نسخة role القديمة.
    const result = await api.permissions.roles()
    const updatedRoles = result.roles || []

    setRoles(updatedRoles)

    const updatedRole = updatedRoles.find(
      (r) => r.role_id === role.role_id
    )

    if (!updatedRole) {
      throw new Error(t('permissions.notFound'))
    }

    setSelected(
      Array.isArray(updatedRole.permissions)
        ? [...updatedRole.permissions]
        : []
    )

    setName(updatedRole.role_name || '')
    setDescription(updatedRole.description || '')

    flash(t('permissions.saved'))
  } catch (e) {
    flash(e.message || t('permissions.saveError'), true)

    // في حالة الفشل نعيد تحميل الحالة الحقيقية من الخادم.
    await load(role.role_id)
  } finally {
    setBusy(false)
  }
}

  const saveMeta = async () => {
    if (!role) return
    setBusy(true)
    try {
      const res = await api.permissions.updateRole(role.role_id, { role_name: name, description })
      flash(res.message || t('permissions.updated'))
      await load(role.role_id)
    } catch (e) {
      flash(e.message, true)
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async () => {
    if (!role) return
    setBusy(true)
    try {
      const res = await api.permissions.setRoleStatus(role.role_id, { is_active: !role.is_active })
      flash(res.message || t('permissions.updated'))
      await load(role.role_id)
    } catch (e) {
      flash(e.message, true)
    } finally {
      setBusy(false)
    }
  }

  const removeRole = async () => {
    if (!role || !window.confirm(t('permissions.deleteConfirm', { name: role.role_name }))) return
    setBusy(true)
    try {
      const res = await api.permissions.deleteRole(role.role_id)
      flash(res.message || t('permissions.deleted'))
      setSelectedId(null)
      await load()
    } catch (e) {
      flash(e.message, true)
    } finally {
      setBusy(false)
    }
  }

  const createRole = async () => {
    if (!newRoleName.trim()) return flash(t('permissions.nameRequired'), true)
    setBusy(true)
    try {
      const res = await api.permissions.createRole({ role_name: newRoleName.trim(), description: newRoleDesc.trim() })
      flash(res.message || t('permissions.created'))
      setNewRoleName('')
      setNewRoleDesc('')
      await load(res.role_id)
    } catch (e) {
      flash(e.message, true)
    } finally {
      setBusy(false)
    }
  }

  if (!canManage) {
    return <div>{t('permissions.noPermission')}</div>
  }

  return (
    <div>
      {message && <div>{message}</div>}
      {error && <div className="perm-error">{error}</div>}
      {busy && <p>{t('permissions.loading')}</p>}
      <div className="perm-layout">
        <aside>
          <h3 className="perm-aside-title">{t('permissions.heading.roles')}</h3>
          <ul className="perm-role-list">
            {roles.map((r) => (
              <li key={r.role_id}>
                <button
                  onClick={() => setSelectedId(r.role_id)}
                  className={`perm-role-btn${r.role_id === selectedId ? ' selected' : ''}${r.is_active ? '' : ' inactive'}`}
                >
                  {ROLE_LABELS[r.role_name] || r.role_name}
                  {r.is_system ? ' ★' : ''}
                  {!r.is_active ? ` (${t('permissions.inactive')})` : ''}
                  <small> — {r.users_count} {t('permissions.userCount')}</small>
                </button>
              </li>
            ))}
          </ul>
          <div className="perm-new-role">
            <strong>{t('permissions.newRole')}</strong>
            <input placeholder="ROLE_NAME" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
            <input placeholder={t('permissions.roleDescription')} value={newRoleDesc} onChange={(e) => setNewRoleDesc(e.target.value)} />
            <button onClick={createRole} disabled={busy}>{t('permissions.createRole')}</button>
          </div>
        </aside>
        <section>
          {!role ? (
            <p>{t('permissions.selectRole')}</p>
          ) : (
            <>
              <div className="perm-meta-bar">
                <input value={name} disabled={isSystem} onChange={(e) => setName(e.target.value)} className="perm-name-input" />
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('permissions.roleDescription')} className="perm-desc-input" />
                <button onClick={saveMeta} disabled={busy || (isSystem && name !== role.role_name)}>{t('permissions.saveMeta')}</button>
                {!isSystem && (
                  <>
                    <button onClick={toggleActive} disabled={busy}>{role.is_active ? t('permissions.disable') : t('permissions.enable')}</button>
                    <button onClick={removeRole} disabled={busy || role.users_count > 0}>{t('permissions.delete')}</button>
                  </>
                )}
              </div>
              {role.users_count > 0 && !isSystem && <p><small>{t('permissions.deleteProtected')}</small></p>}
              {isProtected && <p>{t('permissions.superAdminProtected')}</p>}
              <div>
                {groups.map((g) => (
                  <fieldset key={g.group} className="perm-group">
                    <legend><strong>{g.group}</strong></legend>
          {g.permissions.map((p) => (
            <label key={p.key} className="perm-check">
              <input
                type="checkbox"
                checked={selected.includes(p.key)}
                disabled={isProtected || busy || (isNonSystemAdmin && p.key === 'VIEW_SYSTEM_LOGS')}
                onChange={() => toggle(p.key)}
              />
              {' '}<code>{p.key}</code>{p.description ? ` — ${p.description}` : ''}
            </label>
          ))}
                  </fieldset>
                ))}
              </div>
              <button onClick={savePermissions} disabled={isProtected || busy} className="perm-save">
                {t('permissions.savePermissions')}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
