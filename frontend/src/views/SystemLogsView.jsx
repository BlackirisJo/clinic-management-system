import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useT } from '../i18n';
import { useAuth } from '../auth/AuthContext';
import { Field, Modal, Loading, Empty, Notice, Paginator } from '../components/ui';

const LIMIT = 20;

const ACTION_OPTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'LOGIN_BLOCKED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DELETED',
  'CLINIC_CREATED',
  'CLINIC_UPDATED',
  'PATIENT_CREATED',
  'PATIENT_UPDATED',
  'VISIT_CREATED',
  'PRESCRIPTION_CREATED',
  'PERMISSION_CHANGED',
  'SESSION_REVOKED',
  'EMERGENCY_REPORT_GENERATED',
  'SHARE_CREATED',
  'SHARE_REVOKED',
  'BACKUP_CREATED',
  'BACKUP_RESTORED',
  'SERVICE_CREATED',
  'INVOICE_CREATED',
  'BILL_PAID',
  'ACCOUNTANT_LOGIN',
];

const RESOURCE_TYPE_OPTIONS = [
  'AUTH',
  'USER',
  'CLINIC',
  'PATIENT',
  'VISIT',
  'PRESCRIPTION',
  'ROLE',
  'SESSION',
  'EMERGENCY_REPORT',
  'SHARE',
  'BACKUP',
  'SERVICE',
  'INVOICE',
];

export default function SystemLogsView() {
  const t = useT();
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedLog, setSelectedLog] = useState(null);

  const [filters, setFilters] = useState({
    action: '',
    resource_type: '',
    user_name: '',
    clinic_name: '',
    date_from: '',
    date_to: '',
    search: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filters.action) params.action = filters.action;
      if (filters.resource_type) params.resource_type = filters.resource_type;
      if (filters.user_name) params.user_name = filters.user_name;
      if (filters.clinic_name) params.clinic_name = filters.clinic_name;
      if (filters.date_from) params.date_from = filters.date_from;
      if (filters.date_to) params.date_to = filters.date_to;
      if (filters.search) params.search = filters.search;
      params.page = String(page);
      params.limit = String(LIMIT);
      const result = await api.audit.logs(params);
      setRows(result.logs || []);
      setTotal(result.total || 0);
    } catch (err) {
      setError(err.message || t('systemLogs.loadError'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => { load() }, [load]);

  function applyFilters() {
    setPage(1);
    setShowFilters(false);
  }

  function clearFilters() {
    setFilters({
      action: '', resource_type: '', user_name: '', clinic_name: '',
      date_from: '', date_to: '', search: '',
    });
    setPage(1);
    setShowFilters(false);
  }

  const canExport = user?.roleName === 'SUPER_ADMIN' || (user?.roleName === 'SYSTEM_ADMIN' && (user?.permissions?.includes('VIEW_SYSTEM_LOGS') ?? false));

  const doExport = async (type) => {
    setBusy(true);
    setExportOpen(false);
    try {
      const params = {};
      if (filters.action) params.action = filters.action;
      if (filters.resource_type) params.resource_type = filters.resource_type;
      if (filters.user_name) params.user_name = filters.user_name;
      if (filters.clinic_name) params.clinic_name = filters.clinic_name;
      if (filters.date_from) params.date_from = filters.date_from;
      if (filters.date_to) params.date_to = filters.date_to;
      if (filters.search) params.search = filters.search;
      const filename = type === 'csv' ? `system_logs_${Date.now()}.csv` : `system_logs_${Date.now()}.xlsx`;
      const res = type === 'csv' ? await api.audit.exportCSV(params) : await api.audit.exportExcel(params);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || t('systemLogs.exportError'));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || t('systemLogs.exportError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="full-panel">
      <div className="panel-heading">
        <div><h2>{t('systemLogs.title')}</h2><p>{t('systemLogs.subtitle')}</p></div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {canExport && (
            <div style={{ position: 'relative' }}>
              <button className="primary-button compact" onClick={() => setExportOpen((v) => !v)} disabled={busy}>
                {t('systemLogs.export')} ▾
              </button>
              {exportOpen && (
                <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: '4px', background: '#fff', border: '1px solid #ddd', borderRadius: '6px', zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
                  <button
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px' }}
                    onClick={() => doExport('csv')}
                  >
                    {t('systemLogs.exportCSV')}
                  </button>
                  <button
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px' }}
                    onClick={() => doExport('excel')}
                  >
                    {t('systemLogs.exportExcel')}
                  </button>
                </div>
              )}
            </div>
          )}
          <button className="primary-button compact" onClick={() => setShowFilters((v) => !v)}>
            {showFilters ? t('systemLogs.hideFilters') : t('systemLogs.showFilters')}
          </button>
        </div>
      </div>
      <Notice kind="error">{error}</Notice>

      {showFilters && (
        <div className="record-block" style={{ marginBottom: 16 }}>
          <div className="tab-grid two">
            <Field label={t('systemLogs.filter.action')}>
              <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
                <option value="">{t('systemLogs.filter.all')}</option>
                {ACTION_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Field>
            <Field label={t('systemLogs.filter.resourceType')}>
              <select value={filters.resource_type} onChange={(e) => setFilters({ ...filters, resource_type: e.target.value })}>
                <option value="">{t('systemLogs.filter.all')}</option>
                {RESOURCE_TYPE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label={t('systemLogs.filter.user')}>
              <input value={filters.user_name} onChange={(e) => setFilters({ ...filters, user_name: e.target.value })} placeholder={t('systemLogs.filter.userPlaceholder')} />
            </Field>
            <Field label={t('systemLogs.filter.clinic')}>
              <input value={filters.clinic_name} onChange={(e) => setFilters({ ...filters, clinic_name: e.target.value })} placeholder={t('systemLogs.filter.clinicPlaceholder')} />
            </Field>
            <Field label={t('systemLogs.filter.dateFrom')}>
              <input type="date" value={filters.date_from} onChange={(e) => setFilters({ ...filters, date_from: e.target.value })} />
            </Field>
            <Field label={t('systemLogs.filter.dateTo')}>
              <input type="date" value={filters.date_to} onChange={(e) => setFilters({ ...filters, date_to: e.target.value })} />
            </Field>
            <Field label={t('systemLogs.filter.search')} style={{ gridColumn: '1 / -1' }}>
              <input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder={t('systemLogs.filter.searchPlaceholder')} />
            </Field>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="primary-button compact" onClick={applyFilters}>{t('systemLogs.apply')}</button>
            <button className="secondary-button compact" onClick={clearFilters}>{t('systemLogs.clear')}</button>
          </div>
        </div>
      )}

      {loading ? <Loading text={t('systemLogs.loading')} /> : rows.length === 0 ? <Empty text={t('systemLogs.empty')} /> : (
        <>
          <div className="table-wrap"><table><thead><tr>
            <th>{t('systemLogs.col.dateTime')}</th>
            <th>{t('systemLogs.col.user')}</th>
            <th>{t('systemLogs.col.role')}</th>
            <th>{t('systemLogs.col.clinic')}</th>
            <th>{t('systemLogs.col.action')}</th>
            <th>{t('systemLogs.col.resourceType')}</th>
            <th>{t('systemLogs.col.resourceId')}</th>
            <th>{t('systemLogs.col.details')}</th>
          </tr></thead><tbody>
            {rows.map((log) => (
              <tr key={log.audit_id} style={{ cursor: 'pointer' }} onClick={() => setSelectedLog(log)}>
                <td>{fmtDateTime(log.created_at)}</td>
                <td>{log.user_name || '—'}</td>
                <td>{log.user_role_name || '—'}</td>
                <td>{log.clinic_name || '—'}</td>
                <td><span className="badge">{log.action}</span></td>
                <td>{log.resource_type}</td>
                <td className="hide-sm" data-label={t('systemLogs.col.resourceId')}>{log.resource_id || '—'}</td>
                <td className="hide-sm" data-label={t('systemLogs.col.details')}>
                  {log.metadata ? (
                    <button className="text-button" onClick={(e) => { e.stopPropagation(); setSelectedLog(log); }}>
                      {t('systemLogs.viewDetails')}
                    </button>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody></table></div>
          <Paginator page={page} rows={rows} limit={LIMIT} onPage={setPage} />
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
            {t('systemLogs.total', { total })}
          </div>
        </>
      )}

      {selectedLog && (
        <Modal title={t('systemLogs.logDetails')} onClose={() => setSelectedLog(null)}>
          <div className="record-detail">
            <div><strong>{t('systemLogs.col.dateTime')}:</strong> {fmtDateTime(selectedLog.created_at)}</div>
            <div><strong>{t('systemLogs.col.user')}:</strong> {selectedLog.user_name || '—'}</div>
            <div><strong>{t('systemLogs.col.role')}:</strong> {selectedLog.user_role_name || '—'}</div>
            <div><strong>{t('systemLogs.col.clinic')}:</strong> {selectedLog.clinic_name || '—'}</div>
            <div><strong>{t('systemLogs.col.action')}:</strong> <span className="badge">{selectedLog.action}</span></div>
            <div><strong>{t('systemLogs.col.resourceType')}:</strong> {selectedLog.resource_type}</div>
            <div><strong>{t('systemLogs.col.resourceId')}:</strong> {selectedLog.resource_id || '—'}</div>
            <div><strong>{t('systemLogs.col.details')}:</strong></div>
            {selectedLog.metadata ? (
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--bg)', padding: 12, borderRadius: 6, marginTop: 4 }}>
                {JSON.stringify(selectedLog.metadata, null, 2)}
              </pre>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>{t('systemLogs.noDetails')}</p>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}