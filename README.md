# TinyBuilder

**Construye sitios web y SaaS con modelos de lenguaje corriendo en tu MacBook — sin nube, sin cuotas, sin enviar tu código a nadie.**

TinyBuilder está diseñado para un portátil con **8 GB de RAM compartida** (sin GPU dedicada). Nada aquí asume una máquina grande. Cada decisión está tomada para que dos modelos pequeños quepan en memoria y produzcan proyectos que compilan.

---

## Cómo funciona

Dos modelos trabajan juntos, cada uno en lo que es bueno:

| Rol | Modelo | Por qué |
|---|---|---|
| **Piensa, decide, conversa** | Bonsai 2 4B (96k de contexto) | Memoria larga: recuerda todo el proyecto |
| **Escribe el código** | Qwen3.5 0.8B | Mucho mejor codeando, aunque olvide contexto |

Bonsai nunca escribe código directamente: llama a una herramienta (`write_code`) y la extensión le pide el contenido a Qwen. Tú ves la conversación; el código sale del modelo especializado.

Encima de eso hay tres capas que evitan el desastre típico de los modelos chicos:

1. **Recetas fijas** — cuando pides un sitio estático o un SaaS, se inyecta una receta con el stack cerrado, los archivos exactos y lo que está prohibido. El modelo sigue pasos en vez de improvisar.
2. **Guard por archivo** — cada vez que el modelo escribe un archivo, se verifica al instante: sintaxis real, imports que existan, paquetes declarados, que no mezcle tecnologías. Si algo falla, el error vuelve al modelo con el archivo exacto y se corrige solo (máximo 2 intentos).
3. **Revisión de proyecto** — al terminar cada turno se revisa todo el proyecto y se reporta lo que quedó roto, clasificado por tipo.

Y un panel lateral con **FILES**, **PREVIEW** y **MEMORY** para ver qué se está creando en vivo.

---

## Qué necesita tu Mac

### Hardware

- **8 GB de RAM** como mínimo (es el objetivo de diseño).
- Apple Silicon (M1 o superior) o Intel reciente.
- ~6 GB de disco para modelos y templates.

> **Por qué 8 GB alcanzan:** Bonsai 4B en Q2 ocupa 1.6 GB y Qwen 0.8B ocupa 737 MB. Usamos una variante de Bonsai con **96k de contexto** en lugar de los 262k originales: con 262k, la caché de contexto sola pide **12 GB** en una máquina de 8 y el sistema empieza a escribir a disco. A 96k, Bonsai usa **5.7 GB y 65 % de GPU**. Esa es toda la diferencia entre ir lento y funcionar.

### Software

| Requisito | Cómo se instala | Verificar |
|---|---|---|
| **Ollama** | `brew install --cask ollama` | `ollama --version` |
| **Node.js ≥ 22.19** | `brew install node` | `node -v` |
| **little-coder** | `npm install -g little-coder` | `little-coder --version` |
| **Bonsai 2 4B** | `ollama pull hf.co/prismml/bonsai-2:4b-q2_0` | `ollama list` |
| **Qwen3.5 0.8B** | `ollama pull hf.co/unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M` | `ollama list` |

---

## Instalación

```bash
git clone <este-repo> ~/TinyBuilder
cd ~/TinyBuilder
./bin/tinybuilder --setup
```

`--setup` descarga los dos modelos, crea la variante `bonsai-2-4b-96k` con el contexto correcto para 8 GB, e instala little-coder si falta.

Luego verifica que todo esté en su lugar:

```bash
./bin/tinybuilder --doctor
```

Deberías ver algo así:

```
TinyBuilder — diagnóstico

  ✓ Node v26.8.1
  ✓ Ollama corriendo
  ✓ Bonsai 2 4B 96k (modelo principal)
  ✓ Qwen3.5 0.8B (escribe el código)
  ✓ RAM: 8 GB
  ✓ little-coder instalado
```

---

## Uso

```bash
tinybuilder                 # abre el proyecto del directorio actual
tinybuilder ~/mi-sitio      # abre ese proyecto
```

Dentro de TinyBuilder:

| Comando | Qué hace |
|---|---|
| `/panel` | ocultar o mostrar el panel lateral |
| `/serve` | levanta un servidor local y te da la URL del preview |
| `/stop` | detiene el servidor |
| `/check` | revisa la consistencia del proyecto ahora |
| `alt+e` | edita el archivo abierto en el panel |
| `ctrl+shift+c` | fuerza una revisión del proyecto |
| doble click en PREVIEW | edita el archivo inline |

---

## Templates

Dos proyectos base, ya integrados y probados juntos. **No los reescribas: cópialos.**

| Template | Stack | Para qué |
|---|---|---|
| **static-astrowind** | Astro 7 + Tailwind 4 | Sitios corporativos, blogs, landings. Basado en [AstroWind](https://github.com/arthelokyo/astrowind) (MIT). |
| **saas-nextjs-starter** | Next 14 + better-auth + drizzle + **Whop** | SaaS con login, base de datos y suscripciones. |

Los templates **vienen incluidos en el repo** (`templates/`), así que no hay que descargar nada aparte.

```bash
# ver los disponibles
tinybuilder --templates

# usar uno como base (desde la raíz de tu proyecto nuevo)
cp -R ~/TinyBuilder/templates/static-astrowind/. .
```

### Pagos con Whop

El template de SaaS usa **Whop** como *merchant of record*: cobra en su nombre, se encarga de impuestos y de los chargebacks.

- `WHOP_API_KEY` — clave de la API
- `WHOP_WEBHOOK_SECRET` — secreto para verificar la firma
- `NEXT_PUBLIC_WHOP_PRODUCT_ID` — id del producto

**El acceso se otorga únicamente desde el webhook** (`payment.succeeded`), nunca desde el navegador. La firma se verifica con HMAC-SHA256 y comparación de tiempo constante. Esto no es opcional: es la diferencia entre un cobro seguro y una puerta abierta.

> **Aviso legal:** el starter de SaaS original no incluye licencia. Si vas a publicar un producto sobre él, considera reescribir esa base con el mismo stack.

---

## Qué pedirle (y qué no)

Un modelo de 4B rinde cuando las tareas son concretas y pequeñas. La regla es simple: **un archivo, un paso**.

**Funciona bien:**
```
crea un sitio estático para un colegio en Maipú
agrega una página de contacto al sitio
arregla los imports de app/components
crea un SaaS con login y suscripciones
```

**Falla (y no es culpa del modelo):**
```
hazme toda la aplicación completa de una vez
refactoriza todo el proyecto
```

Si una tarea no avanza, acótala: nombra el archivo y el cambio exacto.

---

## Estructura del proyecto

```
TinyBuilder/
├── bin/tinybuilder        # lanzador (run, --setup, --doctor, --templates)
├── extensions/
│   ├── coder-split.ts     # Bonsai piensa · Qwen escribe
│   ├── side-panel.ts      # FILES / PREVIEW / MEMORY con clicks y edición
│   ├── file-guard.ts      # verifica cada archivo al escribirse
│   ├── project-check.ts   # revisa el proyecto al terminar cada turno
│   └── user-skills.ts     # inyecta las recetas correctas
├── skills/
│   ├── sitio-estatico/    # receta: AstroWind, stack cerrado
│   ├── saas/              # receta: Next + Whop, orden obligatorio
│   ├── frontend-design/   # dirección visual (Anthropic)
│   └── web-artifacts-builder/
├── templates/             # AstroWind + starter SaaS (incluidos)
├── models.json            # Bonsai 96k como modelo por defecto
└── package.json
```

### Dónde vive cada cosa

- **Este repo** — todo: extensiones, skills, templates y lanzador. `TINYBUILDER_HOME` apunta acá.
- **`~/.pi/agent/`** — sesiones y memoria. Compartido con otros agentes Pi.
- **Ollama** — los modelos. Se descargan con `--setup` porque son de Hugging Face.

---

## Problemas frecuentes

**«El modelo tarda mucho o se corta»**
Bonsai está paginando a disco. Verifica con `ollama ps` que diga ~5.7 GB y no 12 GB. Si dice 12, estás usando la variante de 262k: corre `tinybuilder --setup` para crear la de 96k.

**«Los archivos salen rotos»**
El guard debería atraparlo. Si no, corre `ctrl+shift+c` y mira el reporte. Si el error se repite en el mismo archivo, acota la tarea a ese archivo.

**«No encuentra los templates»**
`tinybuilder --templates` te dice la ruta real. Deberían estar en `<repo>/templates/`. Si moviste el repo, la ruta se recalcula sola.

**«No hace nada / no responde»**
Comprueba que Ollama esté corriendo: `tinybuilder --doctor`.

---

## Licencia

MIT para este proyecto. Los templates conservan la licencia de sus autores originales.
