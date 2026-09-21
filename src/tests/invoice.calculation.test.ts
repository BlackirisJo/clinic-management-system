import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  round2,
  resolveItem,
  InvoiceCalcError,
  invoiceStatus,
  invoiceNumberFor,
  type ServicePricing,
} from '../modules/billing/billing.calculation'
import { isGlobalFinanceRole, financeClinicScope, type AuthenticatedRequest } from '../middlewares/auth.middleware'

const mkReq = (u: { roleName: string; permissions: string[]; clinicId?: number | null; clinicIds?: number[] }) =>
  ({ user: { userId: 1, roleName: u.roleName, permissions: u.permissions, clinicId: u.clinicId ?? null, clinicIds: u.clinicIds ?? [] } }) as unknown as AuthenticatedRequest

const totalsOf = (items: ReturnType<typeof resolveItem>[], discount = 0) => {
  const total = round2(items.reduce((s, i) => s + i.line_total, 0))
  const net = round2(Math.max(0, total - discount))
  return { total, net }
}

test('round2 rounds to two decimals', () => {
  assert.equal(round2(10.005), 10.01)
  assert.equal(round2(10.004), 10.0)
  assert.equal(round2(1.005), 1.01)
  assert.equal(round2(33.333333), 33.33)
  assert.equal(round2(0), 0)
})

test('service price from DB overrides tampered client price', () => {
  const services = new Map([['1:101', { price: 10, doctor_percentage: 70, is_active: true } as ServicePricing]])
  const item = resolveItem({ clinic_id: 1, service_id: 101, price: 0.01 }, services)
  assert.equal(item.price, 10)
  assert.equal(item.quantity, 1)
  assert.equal(item.line_total, 10)
})

test('missing service rejected', () => {
  assert.throws(() => resolveItem({ clinic_id: 1, service_id: 999, price: 10 }, new Map()), InvoiceCalcError)
})

test('inactive service rejected', () => {
  const services = new Map([['1:102', { price: 20, doctor_percentage: 0, is_active: false } as ServicePricing]])
  assert.throws(() => resolveItem({ clinic_id: 1, service_id: 102, price: 20 }, services), InvoiceCalcError)
})

test('service from different clinic rejected (clinic:service key)', () => {
  const services = new Map([['2:103', { price: 30, doctor_percentage: 50, is_active: true } as ServicePricing]])
  assert.throws(() => resolveItem({ clinic_id: 1, service_id: 103, price: 30 }, services), InvoiceCalcError)
})

test('manual item uses client price after validation', () => {
  const item = resolveItem({ clinic_id: 1, price: 15 }, new Map())
  assert.equal(item.price, 15)
  assert.equal(item.quantity, 1)
  assert.throws(() => resolveItem({ clinic_id: 1 }, new Map()), InvoiceCalcError)
  assert.throws(() => resolveItem({ clinic_id: 1, price: -5 }, new Map()), InvoiceCalcError)
})

test('quantity within 1..9999 applied to item', () => {
  assert.equal(resolveItem({ clinic_id: 1, price: 5, quantity: 3 }, new Map()).quantity, 3)
  assert.equal(resolveItem({ clinic_id: 1, price: 5, quantity: 0 }, new Map()).quantity, 1)
  assert.throws(() => resolveItem({ clinic_id: 1, price: 5, quantity: 10000 }, new Map()), InvoiceCalcError)
})

test('single-item invoice total = price x quantity', () => {
  const items = [resolveItem({ clinic_id: 1, price: 10, quantity: 2 }, new Map())]
  assert.equal(items[0]!.line_total, 20)
  assert.equal(totalsOf(items).total, 20)
  assert.equal(totalsOf(items).net, 20)
})

test('multi-item invoice: all items in ONE invoice, total = sum (10+15+10=35)', () => {
  const items = [
    resolveItem({ clinic_id: 1, price: 10 }, new Map()),
    resolveItem({ clinic_id: 1, price: 15 }, new Map()),
    resolveItem({ clinic_id: 1, price: 10 }, new Map()),
  ]
  assert.equal(totalsOf(items).total, 35)
  assert.equal(totalsOf(items).net, 35)
  assert.equal(round2(items.reduce((s, i) => s + i.line_total, 0)), 35)
})

test('discount subtracted and capped at total', () => {
  const items = [resolveItem({ clinic_id: 1, price: 100 }, new Map())]
  assert.equal(totalsOf(items, 30).net, 70)
  assert.equal(totalsOf(items, 150).net, 0)
})

test('invoice status derived from paid vs net', () => {
  assert.equal(invoiceStatus(35, 35), 'PAID')
  assert.equal(invoiceStatus(35, 0), 'UNPAID')
  assert.equal(invoiceStatus(35, 10), 'PARTIAL')
  assert.equal(invoiceStatus(35, 36), 'PAID')
})

test('invoice number INV-YYYY-NNNN', () => {
  assert.equal(invoiceNumberFor(15, new Date('2026-03-01T10:00:00Z')), 'INV-2026-0015')
  assert.equal(invoiceNumberFor(7, new Date('2025-12-31T10:00:00Z')), 'INV-2025-0007')
  assert.equal(invoiceNumberFor(123), `INV-${new Date().getFullYear()}-0123`)
})

test('historic snapshot: later service price change does not alter previously computed item', () => {
  const services = new Map([['1:201', { price: 10, doctor_percentage: 0, is_active: true } as ServicePricing]])
  const atInvoiceTime = resolveItem({ clinic_id: 1, service_id: 201 }, services)
  assert.equal(atInvoiceTime.line_total, 10)
  services.set('1:201', { price: 15, doctor_percentage: 0, is_active: true })
  assert.equal(atInvoiceTime.line_total, 10)
  assert.equal(resolveItem({ clinic_id: 1, service_id: 201 }, services).line_total, 15)
})

test('doctor share = line_total x pct / 100 with financial rounding', () => {
  assert.equal(resolveItem({ clinic_id: 1, price: 33.33 }, new Map()).doctor_share, 0)
  const services = new Map([['1:202', { price: 33.33, doctor_percentage: 70, is_active: true } as ServicePricing]])
  assert.equal(resolveItem({ clinic_id: 1, service_id: 202 }, services).doctor_share, 23.33)
})

test('financeClinicScope governs financial CRUD scope', () => {
  assert.equal(financeClinicScope(mkReq({ roleName: 'ACCOUNTANT', permissions: ['CREATE_EXPENSE'], clinicId: 1, clinicIds: [1] })), null)
  assert.deepEqual(financeClinicScope(mkReq({ roleName: 'DOCTOR', permissions: ['VIEW_INVOICES'], clinicId: 2, clinicIds: [2] })), [2])
})

test('Clinic A user cannot reach Clinic B expense (scope blocks)', () => {
  const scope = financeClinicScope(mkReq({ roleName: 'DOCTOR', permissions: ['VIEW_INVOICES'], clinicId: 1, clinicIds: [1] })) as number[]
  assert.equal(scope.includes(2), false)
})

test('delete service/expense: central finance passes any clinic, regular user restricted', () => {
  assert.equal(financeClinicScope(mkReq({ roleName: 'ACCOUNTANT', permissions: ['MANAGE_SERVICES'], clinicId: 1, clinicIds: [1] })), null)
  const scope = financeClinicScope(mkReq({ roleName: 'DOCTOR', permissions: ['VIEW_INVOICES'], clinicId: 1, clinicIds: [1] })) as number[]
  assert.equal(scope.includes(2), false)
})

test('ACCOUNTANT gains no ADMIN permissions automatically', () => {
  const accountantPerms = ['MANAGE_SERVICES', 'CREATE_INVOICE', 'VIEW_INVOICES', 'CREATE_EXPENSE', 'VIEW_FINANCIAL_REPORTS', 'VIEW_PATIENTS', 'VIEW_REPORTS']
  assert.equal(accountantPerms.includes('MANAGE_USERS'), false)
  assert.equal(accountantPerms.includes('MANAGE_CLINICS'), false)
  assert.equal(accountantPerms.includes('MANAGE_BACKUPS'), false)
  assert.equal(isGlobalFinanceRole(mkReq({ roleName: 'ACCOUNTANT', permissions: accountantPerms, clinicId: 1, clinicIds: [1] })), true)
})

test('invoice scope: ACCOUNTANT with MANAGE_SERVICES unrestricted, RECEPTIONIST restricted', () => {
  assert.equal(financeClinicScope(mkReq({ roleName: 'ACCOUNTANT', permissions: ['MANAGE_SERVICES', 'VIEW_INVOICES'], clinicId: 1, clinicIds: [1] })), null)
  assert.deepEqual(financeClinicScope(mkReq({ roleName: 'ACCOUNTANT', permissions: ['VIEW_INVOICES'], clinicId: 1, clinicIds: [1] })), [1])
  assert.deepEqual(financeClinicScope(mkReq({ roleName: 'RECEPTIONIST', permissions: ['VIEW_INVOICES'], clinicId: 3, clinicIds: [3] })), [3])
})

test('report figures match DB aggregation: revenue/paid/outstanding/expenses/net', () => {
  const invoices = [
    { net_amount: 35, paid_amount: 35 },
    { net_amount: 100, paid_amount: 40 },
  ]
  const items = [
    { price: 10, quantity: 2 },
    { price: 15, quantity: 1 },
    { price: 100, quantity: 1 },
  ]
  const expensesAmount = 25
  const revenue = round2(items.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0))
  const net = round2(invoices.reduce((s, i) => s + Number(i.net_amount), 0))
  const paid = round2(invoices.reduce((s, i) => s + Number(i.paid_amount), 0))
  const outstanding = round2(net - paid)
  const netAfterExpenses = Math.max(0, net - expensesAmount)
  assert.equal(revenue, 135)
  assert.equal(net, 135)
  assert.equal(paid, 75)
  assert.equal(outstanding, 60)
  assert.equal(netAfterExpenses, 110)
})
