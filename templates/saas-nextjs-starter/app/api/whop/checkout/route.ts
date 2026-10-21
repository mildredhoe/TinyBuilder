import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createCheckout } from "@/lib/whop";
import { headers } from "next/headers";

/**
 * Crea un checkout de Whop para el usuario autenticado.
 * El `user_id` viaja en los metadatos para poder atribuir el pago después.
 */
export async function POST(req: Request) {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return NextResponse.json({ error: "No autenticado" }, { status: 401 });
	}

	const { productId } = await req.json();
	if (!productId || typeof productId !== "string") {
		return NextResponse.json({ error: "productId requerido" }, { status: 400 });
	}

	try {
		const variant = await createCheckout({
			productId,
			redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?pago=ok`,
		});

		return NextResponse.json({
			purchaseUrl: variant.purchase_url,
			variantId: variant.id,
			userId: session.user.id,
		});
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Error de checkout" },
			{ status: 502 },
		);
	}
}
