export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export interface InvoiceItemInput {
  clinic_id: number;
  doctor_id?: number | null;
  service_id?: number | null;
  price?: number;
  quantity?: number;
}

export interface ServicePricing {
  price: number;
  doctor_percentage: number;
  is_active: boolean;
}

export interface ResolvedInvoiceItem {
  clinic_id: number;
  doctor_id: number | null;
  service_id: number | null;
  price: number;
  quantity: number;
  doctor_percentage: number;
  line_total: number;
  doctor_share: number;
}

export class InvoiceCalcError extends Error {}

//
// resolveItemPricing: السعر المرجعي من الخدمة المسجلة (clinic_services) عند وجود service_id،
// ولا يثق بالسعر القادم من العميل. إذا لم تكن خدمة مرتبطة (بند يدوي) يقبل سعر العميل بعد التحقق.
// كما يتحقق من أن الخدمة تنتمي للعيادة المعطاة ونشطة.
// servicesById مبنية بمفتاح "${clinicId}:${serviceId}".
export const servicesKey = (clinicId: number, serviceId: number): string => `${clinicId}:${serviceId}`;

export const resolveItem = (item: InvoiceItemInput, services?: Map<string, ServicePricing> | null): ResolvedInvoiceItem => {
  const clinicId = Number(item.clinic_id);
  if (!Number.isFinite(clinicId) || clinicId <= 0) throw new InvoiceCalcError('بيانات عنصر الفاتورة غير مكتملة (العيادة)');

  const quantity = item.quantity === undefined || item.quantity === null || item.quantity === 0 ? 1 : Number(item.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new InvoiceCalcError('الكمية يجب أن تكون رقماً صحيحاً بين 1 و 9999');

  let unitPrice: number;
  let doctorPercentage = 0;

  if (item.service_id) {
    const service = services?.get(servicesKey(clinicId, Number(item.service_id)));
    if (!service) throw new InvoiceCalcError('الخدمة غير موجودة في هذه العيادة');
    if (!service.is_active) throw new InvoiceCalcError('لا يمكن إضافة خدمة غير فعالة للفاتورة');
    unitPrice = Number(service.price);
    doctorPercentage = Number(service.doctor_percentage) || 0;
  } else {
    const p = item.price;
    if (p === undefined || p === null || !Number.isFinite(Number(p)) || Number(p) < 0) {
      throw new InvoiceCalcError('بيانات عنصر الفاتورة غير مكتملة (السعر)');
    }
    unitPrice = Number(p);
  }

  const lineTotal = round2(unitPrice * quantity);
  const doctorShare = round2((lineTotal * doctorPercentage) / 100);

  return {
    clinic_id: clinicId,
    doctor_id: item.doctor_id ? Number(item.doctor_id) : null,
    service_id: item.service_id ? Number(item.service_id) : null,
    price: unitPrice,
    quantity,
    doctor_percentage: doctorPercentage,
    line_total: lineTotal,
    doctor_share: doctorShare,
  };
};

export const invoiceStatus = (net: number, paid: number): 'PAID' | 'PARTIAL' | 'UNPAID' => {
  const safePaid = Number(paid) || 0;
  const safeNet = Number(net) || 0;
  if (safePaid >= safeNet) return 'PAID';
  if (safePaid > 0) return 'PARTIAL';
  return 'UNPAID';
};

export const invoiceNumberFor = (invoiceId: number, createdAt?: string | Date | null): string => {
  const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear();
  const yearNum = Number.isNaN(year) ? new Date().getFullYear() : year;
  return `INV-${yearNum}-${String(invoiceId).padStart(4, '0')}`;
};