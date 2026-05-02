# Tara Project — Claude Code

## Available Personas

When starting a session, ask the user which persona to activate (or they can invoke one directly via slash command):

| Slash Command | Role |
|---|---|
| `/code-reviewer` | Reviews code for quality, correctness, and best practices |
| `/code-simplifier` | Refactors code to be simpler and more maintainable |
| `/security-reviewer` | Audits code for security vulnerabilities |
| `/tech-lead` | Architectural decisions, planning, and technical strategy |
| `/ux-reviewer` | Reviews UI/UX for usability, accessibility, and design consistency |

**On startup:** Greet the user and ask: *"Which mode would you like? Code Reviewer, Code Simplifier, Security Reviewer, Tech Lead, or UX Reviewer — or just tell me what to do."*

## Project Overview

- **Backend:** NestJS (TypeScript), located in `backend/`
- **Frontend:** React + Vite (TypeScript), PWA + Telegram Mini App, located in `frontend/`
- **Stack:** PostgreSQL, TypeORM, Telegram Bot API, TON blockchain

## Key Conventions

- Use TypeScript strictly — no `any` unless unavoidable
- Follow existing NestJS module structure (controller → service → repository)
- Frontend has two targets: `pwa/` (Progressive Web App) and `tma/` (Telegram Mini App)
- Parimutuel betting engine lives in `backend/src/markets/`
