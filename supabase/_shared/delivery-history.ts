// Retain old Telegram receipts when a report moves to a Discord webhook.
type Receipt = { sentAt: string | null; ids: (string | number)[] };
type Receipts = Record<string, Receipt>;
type HistoryRow = { sent_at?: string | null; message_ids?: (string | number)[] | { deliveries?: Receipts } | null };
export function deliveryReceipts(row: HistoryRow): Receipts {
  if (Array.isArray(row.message_ids)) return { telegram: { sentAt: row.sent_at || null, ids: row.message_ids } };
  return row.message_ids?.deliveries || {};
}

export function addDeliveryReceipt(receipts: Receipts, key: string, ids: (string | number)[], sentAt: string): Receipts {
  return { ...receipts, [key]: { sentAt, ids } };
}
