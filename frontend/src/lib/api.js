// طبقة اتصال مركزية مع واجهة الـ API الخلفية
// افتراضياً تُرسل الطلبات لنفس المنشأ (نفس عنوان الصفحة) ويقوم خادم التطوير بتمريرها للخلفية عبر الـ proxy.
// عند النشر بشكل منفصل يمكن ضبط VITE_API_URL لقيمة مطلقة.
const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')

let token = typeof localStorage !== 'undefined' ? localStorage.getItem('clinic_token') : null
let unauthorizedHandler = null

export const setAuthToken = (t) => { token = t }
export const getAuthToken = () => token
export const setUnauthorizedHandler = (fn) => { unauthorizedHandler = fn }

const qs = (params = {}) => {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  })
  return search.toString()
}

async function request(path, { method = 'GET', body, params, isForm } = {}) {
  const query = qs(params)
  const url = `${API_URL}${path}${query ? `?${query}` : ''}`
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`

  let payload
  if (body !== undefined) {
    if (isForm) {
      payload = body
    } else {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
  }

  let res
  try {
    res = await fetch(url, { method, headers, body: payload })
  } catch {
    throw new Error('تعذّر الاتصال بالخادم، تحقق من تشغيل الخادم')
  }

  if (res.status === 401) unauthorizedHandler?.()

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = data.message || data.error || `خطأ في الطلب (${res.status})`
    throw new Error(message)
  }
  return data
}

// تنزيل ملف النسخة الاحتياطية مع توكن المصادقة
export async function downloadBackupFile(backupId) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_URL}/api/backups/${backupId}/download`, { headers })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.message || 'تعذّر تنزيل الملف')
  }
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="?([^";]+)"?/)
  const filename = match?.[1] || `backup_${backupId}.enc`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const api = {
  auth: {
    login: (body) => request('/api/auth/login', { method: 'POST', body }),
    me: () => request('/api/auth/me'),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    logoutAll: () => request('/api/auth/logout-all', { method: 'POST' }),
  },
  patients: {
    list: (params) => request('/api/patients', { params }),
    create: (body) => request('/api/patients', { method: 'POST', body }),
    createVisit: (body) => request('/api/patients/visits', { method: 'POST', body }),
    visits: (patientId) => request(`/api/patients/${patientId}/visits`),
    record: (patientId) => request(`/api/patients/${patientId}/record`),
    listShares: (patientId) => request(`/api/patients/${patientId}/shares`),
    share: (patientId, body) => request(`/api/patients/${patientId}/shares`, { method: 'POST', body }),
    revokeShare: (patientId, shareId) => request(`/api/patients/${patientId}/shares/${shareId}`, { method: 'DELETE' }),
  },
  appointments: {
    list: (params) => request('/api/appointments', { params }),
    create: (body) => request('/api/appointments', { method: 'POST', body }),
    updateStatus: (id, body) => request(`/api/appointments/${id}/status`, { method: 'PATCH', body }),
  },
  prescriptions: {
    listMedications: (params) => request('/api/prescriptions/medications', { params }),
    createMedication: (body) => request('/api/prescriptions/medications', { method: 'POST', body }),
    create: (body) => request('/api/prescriptions', { method: 'POST', body }),
    get: (id) => request(`/api/prescriptions/${id}`),
  },
  billing: {
    createService: (body) => request('/api/billing/services', { method: 'POST', body }),
    createInvoice: (body) => request('/api/billing/invoices', { method: 'POST', body }),
    createExpense: (body) => request('/api/billing/expenses', { method: 'POST', body }),
    monthlyKpis: (params) => request('/api/billing/reports/kpis', { params }),
  },
  users: {
    list: (params) => request('/api/users', { params }),
    create: (body) => request('/api/users', { method: 'POST', body }),
    update: (id, body) => request(`/api/users/${id}`, { method: 'PATCH', body }),
  },
  reports: {
    overview: (params) => request('/api/reports/overview', { params }),
    financial: (params) => request('/api/reports/financial', { params }),
    clinical: (params) => request('/api/reports/clinical', { params }),
    appointments: (params) => request('/api/reports/appointments', { params }),
    patients: (params) => request('/api/reports/patients', { params }),
  },
  backups: {
    list: (params) => request('/api/backups/logs', { params }),
    create: () => request('/api/backups', { method: 'POST' }),
    restore: (id) => request(`/api/backups/${id}/restore`, { method: 'POST' }),
    upload: (file, iv, authTag) => {
      const body = new FormData()
      body.append('backup_file', file)
      body.append('iv', iv)
      body.append('auth_tag', authTag)
      return request('/api/backups/upload-restore', { method: 'POST', body, isForm: true })
    },
    download: (id) => downloadBackupFile(id),
  },
}

export default api