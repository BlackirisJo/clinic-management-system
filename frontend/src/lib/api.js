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

// تنزيل نموذج CSV للأدوية مع توكن المصادقة
export async function downloadMedicationTemplate() {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_URL}/api/medications/import/template`, { headers })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.message || 'تعذّر تحميل النموذج')
  }
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="?([^";]+)"?/)
  const filename = match?.[1] || 'medication_template.csv'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
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
    changePassword: (body) => request('/api/auth/change-password', { method: 'POST', body }),
  },
  patients: {
    list: (params) => request('/api/patients', { params }),
    create: (body) => request('/api/patients', { method: 'POST', body }),
    createVisit: (body) => request('/api/patients/visits', { method: 'POST', body }),
    visits: (patientId) => request(`/api/patients/${patientId}/visits`),
    record: (patientId) => request(`/api/patients/${patientId}/record`),
    medicalProfile: (patientId) => request(`/api/patients/${patientId}/medical-profile`),
    saveMedicalProfile: (patientId, body) => request(`/api/patients/${patientId}/medical-profile`, { method: 'PUT', body }),
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
    importTemplate: () => downloadMedicationTemplate(),
    validateImport: (formData) => request('/api/medications/import/validate', { method: 'POST', body: formData, isForm: true }),
    executeImport: (formData) => request('/api/medications/import', { method: 'POST', body: formData, isForm: true }),
  },
  billing: {
    createService: (body) => request('/api/billing/services', { method: 'POST', body }),
    listServices: (params) => request('/api/billing/services', { params }),
    getService: (id) => request(`/api/billing/services/${id}`),
    updateService: (id, body) => request(`/api/billing/services/${id}`, { method: 'PUT', body }),
    deleteService: (id) => request(`/api/billing/services/${id}`, { method: 'DELETE' }),
    createInvoice: (body) => request('/api/billing/invoices', { method: 'POST', body }),
    listInvoices: (params) => request('/api/billing/invoices', { params }),
    getInvoice: (id) => request(`/api/billing/invoices/${id}`),
    createExpense: (body) => request('/api/billing/expenses', { method: 'POST', body }),
    listExpenses: (params) => request('/api/billing/expenses', { params }),
    getExpense: (id) => request(`/api/billing/expenses/${id}`),
    updateExpense: (id, body) => request(`/api/billing/expenses/${id}`, { method: 'PUT', body }),
    deleteExpense: (id) => request(`/api/billing/expenses/${id}`, { method: 'DELETE' }),
    monthlyKpis: (params) => request('/api/billing/reports/kpis', { params }),
  },
  clinics: {
    list: () => request('/api/clinics'),
    directory: () => request('/api/clinics/directory'),
    financialDirectory: () => request('/api/clinics/financial-directory'),
    get: (id) => request(`/api/clinics/${id}`),
    create: (body) => request('/api/clinics', { method: 'POST', body }),
    update: (id, body) => request(`/api/clinics/${id}`, { method: 'PUT', body }),
    staff: (id) => request(`/api/clinics/${id}/staff`),
    addStaff: (id, body) => request(`/api/clinics/${id}/staff`, { method: 'POST', body }),
    updateStaff: (id, userId, body) => request(`/api/clinics/${id}/staff/${userId}`, { method: 'PUT', body }),
    removeStaff: (id, userId) => request(`/api/clinics/${id}/staff/${userId}`, { method: 'DELETE' }),
  },
  clinical: {
    specialties: () => request('/api/clinical/specialties'),
    visit: (visitId) => request(`/api/clinical/visits/${visitId}`),
    updateVisit: (visitId, body) => request(`/api/clinical/visits/${visitId}`, { method: 'PATCH', body }),
    addVitals: (visitId, body) => request(`/api/clinical/visits/${visitId}/vitals`, { method: 'POST', body }),
    deleteVitals: (visitId, vitalId) => request(`/api/clinical/visits/${visitId}/vitals/${vitalId}`, { method: 'DELETE' }),
    addDiagnosis: (visitId, body) => request(`/api/clinical/visits/${visitId}/diagnoses`, { method: 'POST', body }),
    deleteDiagnosis: (visitId, id) => request(`/api/clinical/visits/${visitId}/diagnoses/${id}`, { method: 'DELETE' }),
    addLabOrder: (visitId, body) => request(`/api/clinical/visits/${visitId}/lab-orders`, { method: 'POST', body }),
    updateLabOrder: (visitId, orderId, body) => request(`/api/clinical/visits/${visitId}/lab-orders/${orderId}`, { method: 'PATCH', body }),
    saveLabResults: (visitId, orderId, body) => request(`/api/clinical/visits/${visitId}/lab-orders/${orderId}/results`, { method: 'PUT', body }),
    addImaging: (visitId, body) => request(`/api/clinical/visits/${visitId}/imaging`, { method: 'POST', body }),
    updateImaging: (visitId, imagingId, body) => request(`/api/clinical/visits/${visitId}/imaging/${imagingId}`, { method: 'PATCH', body }),
    addReferral: (visitId, body) => request(`/api/clinical/visits/${visitId}/referrals`, { method: 'POST', body }),
    uploadAttachment: (visitId, file, kind) => {
      const body = new FormData()
      body.append('file', file)
      if (kind) body.append('kind', kind)
      return request(`/api/clinical/visits/${visitId}/attachments`, { method: 'POST', body, isForm: true })
    },
    deleteAttachment: (attachmentId) => request(`/api/clinical/attachments/${attachmentId}`, { method: 'DELETE' }),
    downloadAttachment: async (attachmentId) => {
      const res = await fetch(`${API_URL}/api/clinical/attachments/${attachmentId}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.message || 'تعذّر تنزيل المرفق')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'attachment'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    },
    pregnancies: (patientId) => request('/api/clinical/pregnancies', { params: patientId ? { patient_id: patientId } : {} }),
    pregnancy: (id) => request(`/api/clinical/pregnancies/${id}`),
    createPregnancy: (body) => request('/api/clinical/pregnancies', { method: 'POST', body }),
    updatePregnancy: (id, body) => request(`/api/clinical/pregnancies/${id}`, { method: 'PATCH', body }),
    addPregnancyVisit: (id, body) => request(`/api/clinical/pregnancies/${id}/visits`, { method: 'POST', body }),
    updatePregnancyVisit: (id, pvId, body) => request(`/api/clinical/pregnancies/${id}/visits/${pvId}`, { method: 'PATCH', body }),
    deletePregnancyVisit: (id, pvId) => request(`/api/clinical/pregnancies/${id}/visits/${pvId}`, { method: 'DELETE' }),
    addUltrasound: (id, body) => request(`/api/clinical/pregnancies/${id}/ultrasounds`, { method: 'POST', body }),
    updateUltrasound: (id, usId, body) => request(`/api/clinical/pregnancies/${id}/ultrasounds/${usId}`, { method: 'PATCH', body }),
    deleteUltrasound: (id, usId) => request(`/api/clinical/pregnancies/${id}/ultrasounds/${usId}`, { method: 'DELETE' }),
  },
  users: {
        doctors: (params) => request('/api/users/doctors', { params }),
    list: (params) => request('/api/users', { params }),
    create: (body) => request('/api/users', { method: 'POST', body }),
    update: (id, body) => request(`/api/users/${id}`, { method: 'PATCH', body }),
  },
  permissions: {
    options: () => request('/api/permissions/options'),
    roles: () => request('/api/permissions/roles'),
    createRole: (body) => request('/api/permissions/roles', { method: 'POST', body }),
    updateRole: (id, body) => request(`/api/permissions/roles/${id}`, { method: 'PUT', body }),
    setRolePermissions: (id, body) => request(`/api/permissions/roles/${id}/permissions`, { method: 'PUT', body }),
    setRoleStatus: (id, body) => request(`/api/permissions/roles/${id}/status`, { method: 'PATCH', body }),
    deleteRole: (id) => request(`/api/permissions/roles/${id}`, { method: 'DELETE' }),
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