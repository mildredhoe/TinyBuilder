---
name: sitio-estatico
description: Receta fija para sitios web estáticos usando el template AstroWind (Astro + Tailwind).
keywords: [sitio web, pagina web, landing, pagina estatica, colegio, negocio, portfolio, one page, sitio, astro, astrowind, blog, corporativo]
token_cost: 460
---
RECETA FIJA. No inventes otra estructura ni otro stack.

TEMPLATE BASE (cópialo, no lo reescribas):
$TINYBUILDER_HOME/templates/static-astrowind
Ármalo con: `cp -R $TINYBUILDER_HOME/templates/static-astrowind/. .`
Después adapta el contenido, sin cambiar el stack.

STACK (exacto, nada más):
- astro 7 + tailwind css 4 (ya viene configurado)
- contenido en src/pages y src/components
PROHIBIDO: next, react como framework de páginas, vue, @vue/*, vite suelto, express, @nestjs/*, agregar otro framework CSS

ARCHIVOS CLAVE DEL TEMPLATE (ya existen, edítalos):
- src/pages/index.astro — página principal
- src/components/ — secciones reutilizables
- src/layouts/ — layout base
- src/config.yaml — nombre del sitio, SEO, navegación
- src/assets/ y public/ — imágenes y estáticos
- package.json — scripts: `astro dev`, `astro build`, `astro preview`

REGLAS DURAS:
- Adapta el contenido del template; no crees un proyecto paralelo desde cero.
- Cada import relativo apunta a un archivo que existe.
- Cada paquete importado está en package.json.
- Un componente vive en un solo archivo. No crees duplicados.
- No uses rutas absolutas del sistema para assets.
- Las páginas nuevas van en src/pages/<nombre>.astro y se enlazan desde src/config.yaml.

VERIFICACIÓN FINAL (obligatoria antes de responder):
- Todos los imports resuelven.
- Todos los paquetes están declarados.
- No hay next, vue, vite ni express en el código.
- `npm run build` termina sin errores de sintaxis.
Si algo falla, corrígelo antes de responder.
