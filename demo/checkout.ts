// Demo module for trying Retrace on a real PR. Not part of the Action.
declare const db: { payments: { find(id: string): Promise<unknown>; save(id: string, charge: unknown): Promise<void> } };
declare const stripe: { charges: { create(params: { amount: number }, opts?: { idempotencyKey: string }): Promise<unknown> } };

export interface Item {
  price: number;
  qty: number;
}

/** Total for a cart, after a percentage discount. */
export function cartTotal(items: Item[], discountPct: number): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  return Math.round(total * (1 - discountPct / 100) * 100) / 100;
}

/** Charge an order exactly once. */
export async function chargeOrder(orderId: string, amount: number) {
  const existing = await db.payments.find(orderId);
  if (existing) return existing;
  const charge = await stripe.charges.create({ amount }, { idempotencyKey: `order-${orderId}` });
  try {
    await db.payments.save(orderId, charge); // unique index on order_id, see schema.sql
  } catch {
    // A concurrent request saved this order first; the idempotency key means Stripe charged only once.
    return db.payments.find(orderId);
  }
  return charge;
}
