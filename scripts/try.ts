// Try Jev on one hand-written example, no GitHub needed:
//   TYPESAFE_API_KEY=sk-... npm run try
import { decisionState, Judge } from "../src/jev.js";
import { Verifier } from "../src/verifier.js";

// Pass --verifier to also run the cascade's LLM check (needs ANTHROPIC_API_KEY).
const verifier = process.argv.includes("--verifier") ? new Verifier("claude-sonnet-5-5") : undefined;

const codeWhenCommented = `@@ -10,6 +10,12 @@ export async function chargeOrder(order: Order) {
+  const existing = await payments.findByOrder(order.id);
+  if (existing) return existing;
+  const charge = await stripe.charges.create({ amount: order.total });
+  await payments.save(order.id, charge);
+  return charge;`;

const reviewComment =
  "Race condition: two concurrent requests can both see no existing payment and both charge the card. " +
  "Use an idempotency key on the Stripe call and a unique constraint on payments.order_id.";

const pushes: Record<string, string> = {
  "full fix": `@@ -10,6 +10,8 @@ export async function chargeOrder(order: Order) {
   const existing = await payments.findByOrder(order.id);
   if (existing) return existing;
-  const charge = await stripe.charges.create({ amount: order.total });
-  await payments.save(order.id, charge);
+  const charge = await stripe.charges.create(
+    { amount: order.total },
+    { idempotencyKey: \`order-\${order.id}\` },
+  );
+  await payments.saveUnique(order.id, charge); // unique index on order_id
   return charge;`,
  "partial fix (idempotency key only)": `@@ -10,6 +10,8 @@ export async function chargeOrder(order: Order) {
   const existing = await payments.findByOrder(order.id);
   if (existing) return existing;
-  const charge = await stripe.charges.create({ amount: order.total });
+  const charge = await stripe.charges.create(
+    { amount: order.total },
+    { idempotencyKey: \`order-\${order.id}\` },
+  );
   await payments.save(order.id, charge);
   return charge;`,
  "unrelated change (logging)": `@@ -1,4 +1,5 @@
 import { payments } from "./db";
+import { log } from "./log";

 export async function refund(id: string) {
-  console.log("refund", id);
+  log.info("refund", { id });`,
};

const judge = new Judge(
  {
    apiKey: process.env.TYPESAFE_API_KEY ?? "",
    baseURL: process.env.TYPESAFE_BASE_URL,
    model: process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
  },
);

for (const [name, patch] of Object.entries(pushes)) {
  const t0 = Date.now();
  const input = {
    path: "src/payments.ts",
    reviewComment,
    codeWhenCommented,
    pushFiles: new Map([["src/payments.ts", patch]]),
    commitMessages: [],
  };
  const a = await judge.assess(input);
  const v = verifier && a.pAddressed >= 0.74 ? await verifier.verify(decisionState(input)) : undefined;
  console.log(
    `${name.padEnd(36)} → ${a.status.padEnd(16)} addressed=${a.pAddressed.toFixed(2)} touched=${a.pTouched.toFixed(2)} ` +
      `${a.tokens} tok ${Date.now() - t0}ms` +
      (verifier ? (v ? ` | Sonnet addressed=${v.pAddressed.toFixed(2)} → ${v.pAddressed >= 0.89 ? "✅ confirmed" : "not confirmed"}` : " | Sonnet not asked (Jev < 0.74)") : ""),
  );
}
