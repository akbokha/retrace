-- Demo schema for the checkout module (Retrace demo).
CREATE TABLE payments (
  order_id TEXT NOT NULL,
  charge   JSONB NOT NULL
);

-- At most one payment per order, even under concurrent requests.
CREATE UNIQUE INDEX payments_order_id_unique ON payments (order_id);
