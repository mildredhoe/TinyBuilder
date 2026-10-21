# TinyBuilder

**Build websites and SaaS products with language models running on your own Mac — no cloud, no quotas, no code leaving your machine.**

TinyBuilder is built for a laptop with **8 GB of shared RAM** and no dedicated GPU. Nothing here assumes a big machine. Every decision exists so that two small models fit in memory and still produce projects that compile.

---

## How it works

Two models split the work by strength:

| Role | Model | Why |
|---|---|---|
| **Thinks, decides, talks** | Bonsai 2 4B (96k context) | Long memory: it remembers the whole project |
| **Writes the code** | Qwen3.5 0.8B | Far better at coding, even if it forgets context |

Bonsai never writes code directly. It calls a `write_code` tool, and the extension asks Qwen for the file contents. You see the conversation; the code comes from the specialised model.

On top of that sit three layers that prevent the classic small-model disasters:

1. **Fixed recipes** — when you ask for a static site or a SaaS, a recipe is injected with a locked stack, the exact file list, and what is forbidden. The model follows steps instead of improvising.
2. **Per-file guard** — every time the model writes a file, it is checked instantly: real syntax, imports that resolve, declared packages, no mixed technologies. If something fails, the exact error goes back to the model with the exact file and it repairs itself (two attempts max).
3. **Project review** — at the end of every turn the whole project is checked and whatever is broken is reported, classified by kind.

Plus a side panel with **FILES**, **PREVIEW** and **MEMORY** so you can watch the project being built live.

---

## Requirements

### Hardware

- **8 GB of RAM** minimum — this is the design target.
- Apple Silicon (M1 or newer). Recent Intel works, slower.
- ~6 GB of disk for models and templates.

> **Why 8 GB is enough:** Bonsai 4B at Q2 is 1.6 GB and Qwen 0.8B is 737 MB. We run a Bonsai variant with **96k context** instead of the stock 262k. At 262k the KV cache alone asks for **12 GB** on an 8 GB machine, and the system starts swapping to disk. At 96k, Bonsai uses **5.7 GB and 65% GPU**. That is the whole difference between slow-and-broken and working.

### Software

| Requirement | Install | Verify |
|---|---|---|
| **Ollama** | `brew install --cask ollama` | `ollama --version` |
| **Node.js ≥ 22.19** | `brew install node` | `node -v` |
| **Bonsai 2 4B** | `ollama pull hf.co/prismml/bonsai-2:4b-q2_0` | `ollama list` |
| **Qwen3.5 0.8B** | `ollama pull hf.co/unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M` | `ollama list` |

---

## Install

```bash
git clone https://github.com/mildredhoe/TinyBuilder.git ~/TinyBuilder
cd ~/TinyBuilder
npm install          # brings little-coder, the agent engine, into the project
./bin/tinybuilder --setup
```

`--setup` pulls both models and creates the `bonsai-2-4b-96k` variant with the right context for 8 GB. It also runs `npm install` for you if the dependencies are missing.

**Everything the agent needs lives inside this folder.** `little-coder` is a normal dependency in `package.json`, installed under `node_modules/` — not a global tool you have to hunt down. The only outside pieces are Ollama and the model weights.

Then confirm everything is in place:

```bash
./bin/tinybuilder --doctor
```

You should see:

```
TinyBuilder — doctor

  ✓ Node v26.8.1
  ✓ Ollama running
  ✓ Bonsai 2 4B 96k (main model)
  ✓ Qwen3.5 0.8B (writes the code)
  ✓ RAM: 8 GB
  ✓ little-coder installed
```

> **Note on models:** the weights are not in this repo. They live in Ollama, come from Hugging Face, and carry their own licences. `--setup` downloads them for you.

---

## Usage

```bash
tinybuilder                 # open the project in the current directory
tinybuilder ~/my-site       # open that project
```

Inside TinyBuilder:

| Command | What it does |
|---|---|
| `/panel` | hide or show the side panel |
| `/serve` | start a local server and print the preview URL |
| `/stop` | stop that server |
| `/check` | review the project right now |
| `alt+e` | edit the file open in the panel |
| `ctrl+shift+c` | force a project review |
| double-click in PREVIEW | edit the file inline |

### The panel

- **FILES** — project tree. Click a file to select it, double-click to open it.
- **PREVIEW** — the selected file. Double-click to edit it in place with a small inline editor (`Ctrl+S` saves, `Esc` cancels).
- **MEMORY** — what the assistant has remembered about the project (`alt+m`).

The mouse wheel scrolls whichever side the pointer is over.

---

## Templates

Two base projects, already wired together and tested. **Do not rewrite them — copy them.**

| Template | Stack | Use it for |
|---|---|---|
| **static-astrowind** | Astro 7 + Tailwind 4 | Corporate sites, blogs, landing pages. Based on [AstroWind](https://github.com/arthelokyo/astrowind) (MIT). |
| **saas-nextjs-starter** | Next 14 + better-auth + drizzle + **Whop** | SaaS with login, database and subscriptions. |

Both ship **inside this repo** under `templates/`, so there is nothing extra to download.

```bash
# list what is available
tinybuilder --templates

# start a new project from one (run from the new project's root)
cp -R ~/TinyBuilder/templates/static-astrowind/. .
```

The assistant knows these paths. If you ask for a static site, it copies AstroWind; if you ask for a SaaS, it copies the Next starter. It will not build either from scratch.

### Payments with Whop

The SaaS template uses **Whop** as its *merchant of record*: Whop charges on your behalf and handles tax and chargebacks. That matters a lot for a solo builder in Chile — you do not have to register as a merchant abroad.

- `WHOP_API_KEY` — API key
- `WHOP_WEBHOOK_SECRET` — secret used to verify webhook signatures
- `NEXT_PUBLIC_WHOP_PRODUCT_ID` — product id from the Whop dashboard

**Access is granted only from the webhook** (`payment.succeeded`), never from the browser. The signature is verified with HMAC-SHA256 and a constant-time comparison. That is not optional — it is the difference between a safe charge and an open door.

> **Licence warning:** the original SaaS starter ships without a licence file, which means all rights reserved. If you plan to sell a product built on it, consider rewriting that base with the same stack.

---

## What to ask for (and what not to)

A 4B model delivers when tasks are concrete and small. The rule is simple: **one file, one step**.

**Works well:**
```
create a static site for a school in Maipú
add a contact page to the site
fix the imports in app/components
create a SaaS with login and subscriptions
```

**Fails (and it is not the model's fault):**
```
build me the whole application at once
refactor the entire project
```

If a task stalls, narrow it: name the file and the exact change.

---

## Project layout

```
TinyBuilder/
├── bin/tinybuilder        # launcher (run, --setup, --doctor, --templates)
├── extensions/
│   ├── coder-split.ts     # Bonsai thinks · Qwen writes
│   ├── side-panel.ts      # FILES / PREVIEW / MEMORY, clicks and inline editing
│   ├── file-guard.ts      # checks every file the moment it is written
│   ├── project-check.ts   # reviews the project at the end of each turn
│   └── user-skills.ts     # injects the matching recipes
├── skills/
│   ├── sitio-estatico/    # recipe: AstroWind, locked stack
│   ├── saas/              # recipe: Next + Whop, mandatory order
│   ├── frontend-design/   # visual direction (Anthropic)
│   └── web-artifacts-builder/
├── templates/             # AstroWind + SaaS starter (bundled)
├── models.json            # Bonsai 96k as the default model
├── node_modules/          # little-coder + deps (npm install, not committed)
├── README.md
└── package.json           # depends on little-coder
```

### Where things live

- **This repo** — everything: extensions, skills, templates, launcher. `TINYBUILDER_HOME` points here.
- **`node_modules/`** — little-coder and its dependencies (~197 MB). Installed by `npm install`, not committed.
- **`~/.pi/agent/`** — sessions and memory. Shared with any other Pi agent you run.
- **Ollama** — the model weights. Downloaded by `--setup`, because they are large and licensed separately.

---

## Troubleshooting

**"The model is slow or the response cuts off"**
Bonsai is paging to disk. Run `ollama ps` and check it says about 5.7 GB, not 12 GB. If it says 12 you are on the 262k variant — run `tinybuilder --setup` to create the 96k one.

**"The files come out broken"**
The guard should have caught it. Press `ctrl+shift+c` and read the report. If the same file keeps failing, narrow the task to that file.

**"It cannot find the templates"**
`tinybuilder --templates` prints the real path. They should be under `<repo>/templates/`. The path is recomputed from the repo location, so moving the folder is safe.

**"Nothing happens / no response"**
Check Ollama is running: `tinybuilder --doctor`.

**"The preview does not look right"**
That pane is text-only by design. Use `/serve` and open the URL in a browser for the real thing.

---

## Design notes

A few choices are deliberate and worth knowing before you change them:

- **96k, not 262k.** The larger context does not fit in 8 GB. Lowering it is the single biggest speed and stability win.
- **Bonsai never touches code.** Mixing a long-context model into code generation is what produces plausible-looking but broken files.
- **Recipes over reasoning.** A 4B model cannot plan a whole app. Telling it exactly which stack and which files removes the improvisation where it fails.
- **Checks in code, not in the model.** Asking a small model to verify its own output does not work. The guard verifies it instead and hands back the exact error.
- **One file, one step.** Long JSX files are where small models collapse. Keep files small and tasks smaller.

---

## Licence

MIT for this project. Bundled templates keep the licence of their original authors.
