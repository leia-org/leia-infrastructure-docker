# LEIA Infrastructure Docker

This repository contains Docker Compose configurations for the complete LEIA system infrastructure.

## Overview

The LEIA system consists of 5 main components:

| Component | Repository | Docker Image | Description |
|-----------|------------|--------------|-------------|
| Designer Backend | `leia-designer-backend` | `leia-manager` | Catalog backend service for managing LEIAs, personas, behaviors, and problems |
| Designer Frontend | `leia-designer-frontend` | `leia-workbench-front-public` | Public frontend for creating and browsing LEIA configurations |
| Workbench Backend | `leia-workbench-backend` | `leia-workbench-back` | Backend for running experiments and managing replications |
| Workbench Frontend | `leia-workbench-frontend` | `leia-workbench-front-private` | Private frontend for conducting experiments with participants |
| Runner | `leia-runner` | `leia-runner` | AI model execution service that handles LLM interactions |

## Prerequisites

- Docker and Docker Compose installed
- All 5 projects must have Docker images published to GitHub Container Registry
- GitHub Actions workflows configured for each project to build and push images

## Quick Start

1. Create a `.env` file in this directory with your configuration values (see Environment Variables section below)

2. Start the full system:
   ```bash
   docker-compose up -d
   ```

## Configuration Files

### Full System
- `docker-compose.yaml` - Complete system with all 5 services

### Public Services Only
- `docker-compose-public.yaml` - Designer Backend, Runner, and Designer Frontend
  - Services: Designer Backend (Manager), Runner, Designer Frontend (Workbench Front Public)
  - Databases: MongoDB (catalog), Redis
  - Use case: Creating and managing LEIA configurations

### Private Services Only  
- `docker-compose-private.yaml` - Workbench Backend, Runner, and Workbench Frontend
  - Services: Workbench Backend (Workbench Back), Runner, Workbench Frontend (Workbench Front Private)
  - Databases: MongoDB (workbench), Redis
  - Use case: Running experiments with participants

## Service Ports

| Service | Container Name | Port | Description |
|---------|----------------|------|-------------|
| Designer Backend | `manager` | 3001 | Catalog backend API for LEIAs, personas, behaviors, problems |
| Workbench Backend | `workbench-back` | 3002 | Experiment management and replication API |
| Runner | `runner` | 3003 | AI model execution and LLM interaction API |
| Designer Frontend | `workbench-front-public` | 3004 | Public UI for creating LEIA configurations |
| Workbench Frontend | `workbench-front-private` | 3005 | Private UI for running experiments |
| MongoDB Catalog | `mongodb-catalog` | 27017 | Database for catalog (LEIAs, personas, etc.) |
| MongoDB Workbench | `mongodb-workbench` | 27018 | Database for experiments and sessions |
| Redis | `redis` | 6379 | Cache and session store |

## Environment Variables

Create a `.env` file with the following variables:

### Database
- `MONGO_USERNAME` - MongoDB root username
- `MONGO_PASSWORD` - MongoDB root password
- `MONGO_PORT_CATALOG` - Port for catalog database (default: 27017)
- `MONGO_PORT_WORKBENCH` - Port for workbench database (default: 27018)
- `REDIS_PORT` - Redis port (default: 6379)

### Security & Authentication
- `JWT_SECRET` - Secret key for JWT token signing
- `API_KEY` - API key for manager service authentication
- `RUNNER_KEY` - Authentication key for runner service
- `MANAGER_KEY` - Authentication key for manager service
- `ADMIN_SECRET` - Admin secret for workbench
- `OPENAI_API_KEY` - OpenAI API key for LLM interactions (required)

### Service Configuration
- `NODE_ENV` - Node environment (development/production)
- `DEFAULT_ADMIN_EMAIL` - Default admin user email
- `DEFAULT_ADMIN_PASSWORD` - Default admin user password

### AI/ML Configuration
- `OPENAI_EVALUATION_MODEL` - OpenAI model for evaluations (default: gpt-4o)
- `DEFAULT_MODEL` - Default model provider (default: openai)

### Service URLs (Internal)
- `MANAGER_URL` - Manager service URL (e.g., http://manager:80)
- `WORKBENCH_BACK_URL` - Workbench backend URL (e.g., http://workbench-back:80)
- `RUNNER_URL` - Runner service URL (e.g., http://runner:80)

### Frontend URLs
- `FRONTEND_URL_PUBLIC` - Public frontend URL (e.g., http://localhost:3004)
- `FRONTEND_URL_PRIVATE` - Private frontend URL (e.g., http://localhost:3005)

### Service Ports (External)
- `PORT_MANAGER` - External port for manager (default: 3001)
- `PORT_WORKBENCH_BACK` - External port for workbench backend (default: 3002)
- `PORT_RUNNER` - External port for runner (default: 3003)
- `PORT_WORKBENCH_FRONT_PUBLIC` - External port for public frontend (default: 3004)
- `PORT_WORKBENCH_FRONT_PRIVATE` - External port for private frontend (default: 3005)

## Development

For development, you can use local builds by modifying the docker-compose files to use local Dockerfiles instead of pulling from GHCR.

### Future Optimization: Multi-Stage Docker Builds

The current Dockerfiles use single-stage builds for simplicity. For production deployments, consider implementing multi-stage builds to:
- Reduce final image size (from ~1.5GB to ~200MB for frontend images)
- Improve security by excluding build tools from production images
- Speed up deployment times

This optimization is recommended once the current setup is validated and stable.

### Example `.env` file for local development:
```bash
# Database
MONGO_USERNAME=admin
MONGO_PASSWORD=changeme
MONGO_PORT_CATALOG=27017
MONGO_PORT_WORKBENCH=27018
REDIS_PORT=6379

# Security
JWT_SECRET=your-jwt-secret-here
API_KEY=your-api-key-here
RUNNER_KEY=your-runner-key-here
MANAGER_KEY=your-manager-key-here
ADMIN_SECRET=your-admin-secret-here
OPENAI_API_KEY=sk-your-openai-api-key-here

# Service Configuration
NODE_ENV=development
DEFAULT_ADMIN_EMAIL=admin@example.com
DEFAULT_ADMIN_PASSWORD=changeme

# AI/ML Configuration
OPENAI_EVALUATION_MODEL=gpt-4o
DEFAULT_MODEL=openai

# Service URLs (Internal - Docker network)
MANAGER_URL=http://manager:80
WORKBENCH_BACK_URL=http://workbench-back:80
RUNNER_URL=http://runner:80

# Frontend URLs (External)
FRONTEND_URL_PUBLIC=http://localhost:3004
FRONTEND_URL_PRIVATE=http://localhost:3005

# Service Ports (External)
PORT_MANAGER=3001
PORT_WORKBENCH_BACK=3002
PORT_RUNNER=3003
PORT_WORKBENCH_FRONT_PUBLIC=3004
PORT_WORKBENCH_FRONT_PRIVATE=3005
```

## Security Notes

- Change all default passwords and secrets in production
- Use strong, unique values for all security keys
- Consider using Docker secrets for sensitive data in production
- Ensure proper firewall rules for exposed ports
