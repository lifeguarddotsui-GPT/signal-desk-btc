# Lifeguard.sui - AI Trading Platform

## Overview
Web3 AI trading platform where AI agents trade SUI-PERP on users' behalf. Features a Market Dashboard with real-time indicators, Deploy Agent configuration, and Claim Rewards section.

## Architecture
- **Frontend**: React + Vite + Tailwind + shadcn/ui + Recharts
- **Backend**: Express.js with PostgreSQL (Drizzle ORM)
- **Market Engine**: Simulated real-time SUI-PERP price data with RSI, EMA indicators
- **Theme**: Dark crypto trading theme with teal primary color (hsl 173 80% 40%)

## Key Files
- `shared/schema.ts` - Data models (users, agents, signals, orders, rewards, marketData)
- `server/routes.ts` - API endpoints
- `server/storage.ts` - Database storage layer
- `server/market-engine.ts` - Simulated market data engine
- `server/seed.ts` - Seed data for demo
- `client/src/pages/market-dashboard.tsx` - Market Dashboard page
- `client/src/pages/deploy-agent.tsx` - Deploy Agent page
- `client/src/pages/claim-rewards.tsx` - Claim Rewards page
- `client/src/components/app-sidebar.tsx` - Sidebar navigation

## API Routes
- GET `/api/market` - Current market data
- GET `/api/market/history` - Price history (60 points)
- GET `/api/market/indicators` - RSI/EMA indicator history
- GET `/api/signals` - Latest trading signals
- GET `/api/agents` - List agents
- POST `/api/agents` - Create agent
- PATCH `/api/agents/:id` - Update agent
- GET `/api/rewards/summary` - Reward summary
- POST `/api/rewards/:id/claim` - Claim single reward
- POST `/api/rewards/claim-all` - Claim all rewards

## Running
- `npm run dev` starts the Express + Vite server on port 5000
- Database schema pushed via `npm run db:push`
