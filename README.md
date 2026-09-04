# LEIA Infrastructure Docker

Este repositorio contiene la configuración unificada de Docker Compose para desplegar toda la infraestructura del sistema LEIA con un único comando.

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
