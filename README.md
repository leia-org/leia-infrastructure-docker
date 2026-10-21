# LEIA Infrastructure Docker

Este repositorio contiene la configuración unificada de Docker Compose para desplegar toda la infraestructura del sistema LEIA con un único comando.

Para enlazar PRs de frontend y backend con datos de preview aislados, consulta
[entornos de preview enlazados](previews/README.md).

## Descripción General

El sistema LEIA consta de 6 microservicios y sus bases de datos:

| Component | Repositorio | Imagen Docker | Puerto Host por Defecto | Descripción |
|------------|-------------|---------------|-------------------------|-------------|
| **Auth** | `leia-auth` | `ghcr.io/leia-org/leia-auth:latest` | `3005` | Microservicio central de autenticación y gestión de API keys |
| **Designer Backend** | `leia-designer-backend` | `ghcr.io/leia-org/leia-designer-backend:latest` | `3000` | API backend para gestión de LEIAs, personas, comportamientos y problemas |
| **Designer Frontend** | `leia-designer-frontend` | `ghcr.io/leia-org/leia-designer-frontend:latest` | `5173` | Interfaz web para diseño y configuración de LEIAs |
| **Workbench Backend** | `leia-workbench-backend` | `ghcr.io/leia-org/leia-workbench-backend:latest` | `3001` | API backend para gestión y ejecución de experimentos y réplicas |
| **Workbench Frontend** | `leia-workbench-frontend` | `ghcr.io/leia-org/leia-workbench-frontend:latest` | `8080` | Interfaz web para participantes e investigadores del Workbench |
| **Runner** | `leia-runner` | `ghcr.io/leia-org/leia-runner:latest` | `5002` | Motor de ejecución de sesiones IA e interacción con LLMs |
| **MongoDB** | `mongo:latest` | - | `27017` | Base de datos MongoDB unificada (alberga las DBs `auth`, `designer`, `workbench`) |
| **Redis** | `redis:latest` | - | `6379` | Cache y gestión de sesiones para Runner |
| **MinIO (S3)** | `quay.io/minio/minio:latest` | - | `9000` (API) / `9001` (Consola) | Almacenamiento de objetos S3 local para imágenes del Designer |

---

## Requisitos Previos

- Docker y Docker Compose instalados en tu sistema.
- Clave de API de OpenAI (requerida por el servicio `runner`).

---

## Inicio Rápido (Quick Start)

1. Crea tu archivo de variables de entorno copiando `.env.example`:
   ```bash
   cp .env.example .env
   ```

2. Configura tus credenciales y claves en `.env`

3. Lanza todo el ecosistema LEIA:
   ```bash
   # Usando imágenes publicadas o construyendo localmente
   docker compose up -d

   # O para forzar la construcción desde el código local:
   docker compose up -d --build
   ```

4. Detener todos los servicios:
   ```bash
   docker compose down

   # Para reiniciar desde cero eliminando los volúmenes de datos:
   docker compose down -v
   ```

---

## URLs de Acceso

Una vez levantados los contenedores, los servicios están disponibles en:

- **Designer Frontend**: [http://localhost:5173](http://localhost:5173)
- **Workbench Frontend**: [http://localhost:8080](http://localhost:8080)
- **Auth Service API**: [http://localhost:3005](http://localhost:3005)
- **Designer Backend API**: [http://localhost:3000](http://localhost:3000)
- **Workbench Backend API**: [http://localhost:3001](http://localhost:3001)
- **Runner API**: [http://localhost:5002](http://localhost:5002)
- **MinIO S3 API**: [http://localhost:9000](http://localhost:9000)
- **MinIO Console**: [http://localhost:9001](http://localhost:9001) (User: `minio`, Pass: `minio123`)

---

## Variables de Entorno Principales

Consulta el archivo `.env.example` para la lista completa. Las variables más relevantes son:

- `OPENAI_API_KEY`: Clave de API para interacción con modelos de lenguaje.
- `JWT_SECRET`: Secreto para firma y validación de tokens JWT.
- `API_KEY`: Clave API para comunicación segura entre servicios.
- `RUNNER_KEY`: Clave de autenticación para el servicio Runner.
- `INTERN_TOKEN`: Token para la comunicación interna entre microservicios y Auth.
- `ADMIN_SECRET`: Secreto de administrador para operaciones privilegiadas en Workbench.
- `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD`: Credenciales por defecto para el usuario inicial.

---

## Promote develop to production

Open [Promote develop to main](https://github.com/leia-org/leia-infrastructure-docker/actions/workflows/promote-production.yml)
in Actions and select **Run workflow** on `main`. Choose `all`, `auth`, `designer`,
`workbench` or `runner`. Designer and Workbench include both frontend and backend;
`all` covers the six application repositories. Only active `leia-org` members can
run the promotion. Start with **dry_run** to inspect variables and release PRs
without changing anything.

The action compares stable pre and production provider configuration and checks
new keys declared in root `.env*.example` files at the exact develop/main commits.
Build develop in the stable pre environment first, so its Cloudflare build variables
reflect the configuration you have tested. Keep environment examples current when
introducing new variables; the action does not execute application code to discover them.
Known LEIA service URLs are translated to production and reviewed neutral session
settings can be copied. Existing production values are preserved by default.
Preview CORS domains, the Turnstile bypass token and the preview CI install switch
are excluded. Variables are never deleted.

Store new credentials, connections and other environment-specific production values
in the repository Actions secret **LEIA_PRODUCTION_ENV_JSON**, keyed by service:

```json
{
  "auth": {"NEW_API_TOKEN": "replace-with-production-value"},
  "designer_backend": {"S3_REGION": "auto"},
  "designer_frontend": {},
  "workbench_backend": {},
  "workbench_frontend": {},
  "runner": {"AVATAR_KBYTES": "4"}
}
```

All values must be strings. Use the six service identifiers shown above; empty
objects can be omitted. Add real values through GitHub's secret settings, never
through a PR, workflow input or comment. Frontend keys must start with `VITE_` and
are public in the compiled browser bundle. Existing production sitekeys, database
connections and credentials are kept. If you intentionally want to update an
existing value from the central secret, select **update_existing_env**; this only
changes keys explicitly included in that secret. No value is copied blindly from
pre for a new credential, storage setting or sitekey.

The entire selected scope must have all required production values before any
provider write or release PR creation. Missing keys appear by name in the summary.
The action checks for concurrent branch/configuration changes, then upserts variables
into Coolify's production application environments and Cloudflare's **main build
variables**, not static Worker runtime bindings. It verifies the saved values without
printing them. It does not restart services, trigger builds or copy databases.
A provider failure stops PR creation; already saved keys remain and a rerun safely
reuses them. There is no cross-provider transaction or automatic rollback.

After environment synchronization, `leia-org-bot` creates a normal `develop` → `main`
PR wherever develop has changes, reuses an existing release PR and skips repositories
with no commits to promote. The summary and one bot comment per release PR link the
selected releases and list variable names, never values. Human titles and descriptions
are preserved. Repeated runs do not create duplicate PRs or comments.

Review and merge through the repositories' existing checks and approvals; keep
`develop` when merging. Frontends use the existing Cloudflare production builds;
Auth, Designer API, Workbench API and Runner use their existing Coolify production
applications on Hetzner. New settings take effect at the next deployment; coordinate
Auth/token issuer and consumer changes so services remain compatible during rollout.
These PRs track later pushes to develop and do not freeze a version or provide an
atomic release across repositories. Rerun the action before merging if code or
configuration changed after planning.

## Ask the bot to update a PR

Post `/leia <instruction>` in an application PR conversation, for example
`/leia fix merge conflicts of this branch`. Active organization members can ask
`leia-org-bot` to implement changes with `gpt-6-luna`, run checks and add a verified
commit to the PR branch. Commands are centrally polled, normally every five minutes.
See [agent commands](agent/README.md) for setup, verification and supported scope.
