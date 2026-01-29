# LEIA Infrastructure Docker

This repository contains Docker Compose configurations for the complete LEIA system infrastructure.

## Overview

The LEIA system consists of 5 main components:

| Component | Repository | Docker Image | Description |
|-----------|------------|--------------|-------------|
| Designer Backend | `leia-designer-backend` | `leia-designer-backend` | Backend service for managing LEIAs, personas, behaviors, and problems (public) |
| Designer Frontend | `leia-designer-frontend` | `leia-designer-frontend` | Frontend for creating and browsing LEIA configurations (public) |
| Workbench Backend | `leia-workbench-backend` | `leia-workbench-backend` | Backend for running experiments and managing replications (private) |
| Workbench Frontend | `leia-workbench-frontend` | `leia-workbench-frontend` | Frontend for conducting experiments with participants (private) |
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

### Designer Services Only (Public)
- `docker-compose-public.yaml` - Designer Backend, Runner, and Designer Frontend
  - Services: Designer Backend, Runner, Designer Frontend
  - Databases: MongoDB (designer), Redis
  - Use case: Creating and managing LEIA configurations

### Workbench Services Only (Private)
- `docker-compose-private.yaml` - Workbench Backend, Runner, and Workbench Frontend
  - Services: Workbench Backend, Runner, Workbench Frontend
  - Databases: MongoDB (workbench), Redis
  - Use case: Running experiments with participants

## Service Ports

| Service | Container Name | Port | Description |
|---------|----------------|------|-------------|
| Designer Backend | `designer-backend` | 3001 | Backend API for LEIAs, personas, behaviors, problems (public) |
| Workbench Backend | `workbench-backend` | 3002 | Experiment management and replication API (private) |
| Runner | `runner` | 3003 | AI model execution and LLM interaction API |
| Designer Frontend | `designer-frontend` | 3004 | Frontend for creating LEIA configurations (public) |
| Workbench Frontend | `workbench-frontend` | 3005 | Frontend for running experiments (private) |
| MongoDB Designer | `mongodb-designer` | 27017 | Database for designer (LEIAs, personas, etc.) |
| MongoDB Workbench | `mongodb-workbench` | 27018 | Database for experiments and sessions |
| Redis | `redis` | 6379 | Cache and session store |

## Environment Variables

Create a `.env` file with the following variables:

### Database
- `MONGO_USERNAME` - MongoDB root username
- `MONGO_PASSWORD` - MongoDB root password
- `MONGO_PORT_DESIGNER` - Port for designer database (default: 27017)
- `MONGO_PORT_WORKBENCH` - Port for workbench database (default: 27018)
- `REDIS_PORT` - Redis port (default: 6379)

### Security & Authentication
- `JWT_SECRET` - Secret key for JWT token signing
- `API_KEY` - API key for designer backend authentication
- `RUNNER_KEY` - Authentication key for runner service
- `DESIGNER_BACKEND_KEY` - Authentication key for designer backend service
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
- `DESIGNER_BACKEND_URL` - Designer backend service URL (e.g., http://designer-backend:80)
- `WORKBENCH_BACKEND_URL` - Workbench backend URL (e.g., http://workbench-backend:80)
- `RUNNER_URL` - Runner service URL (e.g., http://runner:80)

### Frontend URLs
- `DESIGNER_FRONTEND_URL` - Designer frontend URL (e.g., http://localhost:3004)
- `WORKBENCH_FRONTEND_URL` - Workbench frontend URL (e.g., http://localhost:3005)

### Service Ports (External)
- `PORT_DESIGNER_BACKEND` - External port for designer backend (default: 3001)
- `PORT_WORKBENCH_BACKEND` - External port for workbench backend (default: 3002)
- `PORT_RUNNER` - External port for runner (default: 3003)
- `PORT_DESIGNER_FRONTEND` - External port for designer frontend (default: 3004)
- `PORT_WORKBENCH_FRONTEND` - External port for workbench frontend (default: 3005)

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
MONGO_PORT_DESIGNER=27017
MONGO_PORT_WORKBENCH=27018
REDIS_PORT=6379

# Security
JWT_SECRET=your-jwt-secret-here
API_KEY=your-api-key-here
RUNNER_KEY=your-runner-key-here
DESIGNER_BACKEND_KEY=your-designer-backend-key-here
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
DESIGNER_BACKEND_URL=http://designer-backend:80
WORKBENCH_BACKEND_URL=http://workbench-backend:80
RUNNER_URL=http://runner:80

# Frontend URLs (External)
DESIGNER_FRONTEND_URL=http://localhost:3004
WORKBENCH_FRONTEND_URL=http://localhost:3005

# Service Ports (External)
PORT_DESIGNER_BACKEND=3001
PORT_WORKBENCH_BACKEND=3002
PORT_RUNNER=3003
PORT_DESIGNER_FRONTEND=3004
PORT_WORKBENCH_FRONTEND=3005
```

## Security Notes

- Change all default passwords and secrets in production
- Use strong, unique values for all security keys
- Consider using Docker secrets for sensitive data in production
- Ensure proper firewall rules for exposed ports
