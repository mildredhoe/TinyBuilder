import { NextResponse } from "next/server";
import { applyPayment, verifyWebhook } from "@/lib/whop";

/**
 * Webhook de Whop. Es la única fuente de verdad para otorgar acceso:
 * nunca confiamos en lo que diga el navegador.
 */
export async function POST(req: Request) {
	const raw = await req.text();
	const signature = req.headers.get("whop-signature");

	if (!verifyWebhook(raw, signature)) {
		return NextResponse.json({ error: "Firma inválida" }, { status: 401 });
	}

	let event: { type?: string; data?: Record<string, unknown> };
	try {
		event = JSON.parse(raw);
	} catch {
		return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
	}

	// Solo los pagos confirmados dan acceso.
	if (event.type !== "payment.succeeded" || !event.data) {
		return NextResponse.json({ received: true });
	}

	try {
		await applyPayment(event.data as Parameters<typeof applyPayment>[0]);
	} catch (error) {
		console.error("Whop webhook error:", error);
		// Devolvemos 500 para que Whop reintente.
		return NextResponse.json({ error: "No se pudo aplicar el pago" }, { status: 500 });
	}

	return NextResponse.json({ received: true });
}
