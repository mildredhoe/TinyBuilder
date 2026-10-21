/**
 * Whop — pagos como Merchant of Record.
 *
 * Whop cobra en su nombre, se encarga de impuestos y chargebacks, y nos
 * manda un webhook cuando el pago se completa. Nunca confiamos en el
 * navegador: el acceso se otorga desde el webhook.
 *
 * Flujo:
 *   1. El usuario pulsa "suscribirse" -> POST /api/whop/checkout
 *   2. Le devolvemos `purchase_url` y lo redirigimos
 *   3. Whop cobra y llama a POST /api/whop/webhook
 *   4. Verificamos la firma y actualizamos la suscripción en la base
 */

import { db } from "@/db/drizzle";
import { subscription } from "@/db/schema";
import crypto from "node:crypto";

const WHOP_API = "https://api.whop.com/api/v2";

export type WhopVariant = {
  purchase_url: string;
  id: string;
};

/**
 * Crea (o reutiliza) una variante de producto y devuelve la URL de compra.
 * Los ids de producto salen del dashboard de Whop.
 */
export async function createCheckout(opts: {
  productId: string;
  planType?: "one_time" | "renewal";
  redirectUrl?: string;
}): Promise<WhopVariant> {
  const res = await fetch(`${WHOP_API}/variants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_id: opts.productId,
      plan_type: opts.planType ?? "renewal",
      redirect_url: opts.redirectUrl ?? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whop checkout failed: ${res.status} ${body.slice(0, 200)}`);
  }

  return (await res.json()) as WhopVariant;
}

/** Verifica la firma HMAC del webhook de Whop. */
export function verifyWebhook(rawBody: string, signature: string | null): boolean {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // Comparación de tiempo constante: no filtra información por timing.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

type WhopPayment = {
  id: string;
  status: string;
  user_id?: string;
  membership_id?: string;
  product_id?: string;
  total?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  valid_until?: string | null;
};

/** Aplica un pago confirmado a la tabla de suscripciones. */
export async function applyPayment(payment: WhopPayment): Promise<void> {
  const userId =
    (payment.metadata?.user_id as string | undefined) ?? payment.user_id ?? null;

  await db
    .insert(subscription)
    .values({
      id: payment.membership_id ?? payment.id,
      userId,
      productId: payment.product_id ?? "",
      status: payment.status,
      amount: Math.round((payment.total ?? 0) * 100),
      currency: payment.currency ?? "USD",
      recurringInterval: "month",
      currentPeriodStart: new Date(),
      currentPeriodEnd: payment.valid_until
        ? new Date(payment.valid_until)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      startedAt: new Date(),
      canceledAt: null,
      cancelAtPeriodEnd: false,
      customerId: payment.user_id ?? "",
      productIdWhop: payment.product_id ?? "",
    })
    .onConflictDoUpdate({
      target: subscription.id,
      set: {
        status: payment.status,
        currentPeriodEnd: payment.valid_until
          ? new Date(payment.valid_until)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        modifiedAt: new Date(),
      },
    });
}
