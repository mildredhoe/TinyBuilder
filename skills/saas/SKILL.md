---
name: saas
description: Receta fija para construir un SaaS. Stack cerrado, orden obligatorio, pagos con Whop (merchant of record).
keywords: [saas, app, aplicacion, dashboard, panel, auth, login, base de datos, pagos, checkout, suscripcion, whop, multiusuario, backoffice, administracion, plan, premium]
token_cost: 620
---
RECETA FIJA. No inventes otro stack, otro orden ni otro procesador de pagos.

TEMPLATE BASE (cópialo, no lo reescribas):
$TINYBUILDER_HOME/templates/saas-nextjs-starter
Ármalo con: `cp -R $TINYBUILDER_HOME/templates/saas-nextjs-starter/. .`
Después adapta, sin cambiar el stack ni el sistema de pagos.

STACK (exacto, nada más):
- next 14 + react 18 + typescript
- better-auth para autenticación (ya viene integrado)
- drizzle + postgres (Neon) para datos
- zod para validación
- tailwind + shadcn/ui para UI
- **Whop para pagos** (merchant of record: cobra, maneja impuestos y chargebacks)
PROHIBIDO: vue, @vue/*, vite, @vitejs/*, angular, svelte, express, @nestjs/*, react-router-dom (Next ya enruta), **stripe**, **polar**, @polar-sh/*

PAGOS CON WHOP (reglas que no se negocian):
1. El checkout se crea en el servidor: POST /api/whop/checkout devuelve `purchase_url`. El cliente solo redirige.
2. El acceso se otorga SOLO desde el webhook: POST /api/whop/webhook escucha `payment.succeeded`.
3. La firma del webhook se verifica con HMAC-SHA256 y comparación de tiempo constante. Nunca confíes en el navegador.
4. Las variables son WHOP_API_KEY, WHOP_WEBHOOK_SECRET y NEXT_PUBLIC_WHOP_PRODUCT_ID. No uses claves de Stripe ni de Polar.
5. El `user_id` viaja en los metadatos del checkout para atribuir el pago a la cuenta correcta.

ORDEN OBLIGATORIO DE TRABAJO:
1. package.json y dependencias reales
2. Esquema de datos (drizzle)
3. Autenticación
4. Endpoints de API (incluido el checkout de Whop)
5. Webhook de Whop
6. UI que consume todo lo anterior
Si empiezas por la UI sin tener 1-5, el proyecto queda a medias. No lo hagas.

REGLAS DURAS:
- Cada import relativo apunta a un archivo que existe o que creas en el mismo paso.
- Cada paquete importado está en package.json. Si no existe en npm, NO lo inventes.
- Un componente vive en un solo archivo. No crees duplicados.
- Un archivo no pasa de 200 líneas. Si crece, pártelo en módulos.
- No pongas claves secretas en el código. Van en .env.local.

VERIFICACIÓN FINAL (obligatoria antes de responder):
- Todos los imports resuelven.
- Todos los paquetes están declarados.
- No hay stripe, polar, vue, vite ni express en el código.
- El JSX abre y cierra sus etiquetas.
- `npx tsc --noEmit` sin errores de sintaxis.
Si algo falla, corrígelo antes de responder.
