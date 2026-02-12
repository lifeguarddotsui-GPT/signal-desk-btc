# Lifeguard.sui - AI Trading Platform

## Overview
Web3 AI trading platform where AI agents autonomously trade SUI-PERP perpetual contracts. Features a Market Dashboard with live Pyth Oracle + Sudo Finance price feeds, enhanced indicators (Connors RSI, RSI Divergence, DEMA, TEMA), Deploy Agent with funding flow and protocol fees, Claim Rewards with wallet verification, and WebSocket real-time updates.

## Architecture
- **Frontend**: React + Vite + Tailwind + shadcn/ui + Recharts + @mysten/dapp-kit (SUI wallet)
- **Backend**: Express.js with PostgreSQL (Drizzle ORM) + WebSocket server
- **Price Service**: Live Pyth Oracle (primary) + Sudo Finance (secondary) with blended pricing
- **Indicators**: shared/indicators.ts - Connors RSI, DEMA, TEMA, RSI Divergence
- **Signal Engine**: Score-based (3-of-6 conditions) for long/short signal generation
- **Theme**: Dark crypto trading theme with teal primary color (hsl 173 80% 40%)
- **Protocol Fee**: 2% on all agent deposits, sent to 0xf407...13d6 (Blue Water Digital)

## Key Files
- `shared/schema.ts` - Data models (users, agents, signals, orders, positions, rewards, marketData, protocolFees)
- `shared/indicators.ts` - Connors RSI, DEMA, TEMA, RSI Divergence calculations
- `server/routes.ts` - API endpoints
- `server/storage.ts` - Database storage layer (IStorage interface)
- `server/market-engine.ts` - Market data engine with live price service
- `server/price-service.ts` - Pyth Oracle + Sudo Finance price fetching
- `server/seed.ts` - Seed data for demo
- `client/src/pages/market-dashboard.tsx` - Market Dashboard with live charts/indicators
- `client/src/pages/deploy-agent.tsx` - Deploy Agent with funding dialog, protocol fees
- `client/src/pages/claim-rewards.tsx` - Claim Rewards page
- `client/src/components/app-sidebar.tsx` - Sidebar navigation
- `client/src/lib/ws-context.tsx` - WebSocket context for real-time price updates
- `client/src/lib/seo.tsx` - SEO helper hook

## API Routes
- GET `/api/market` - Current market data (with priceSource field)
- GET `/api/market/history` - Price history (60 points)
- GET `/api/market/indicators` - RSI/Connors RSI/EMA/DEMA/TEMA indicator history
- GET `/api/signals` - Latest trading signals with signalScore (e.g. "L2/S3")
- GET `/api/agents` - List agents (with balance, wallet, PnL tracking)
- POST `/api/agents` - Create agent (generates unique wallet, starts at 0 SUI)
- PATCH `/api/agents/:id` - Update agent status
- POST `/api/agents/:id/deposit` - Deposit SUI to agent (2% protocol fee applied)
- GET `/api/agents/:id/positions` - Agent positions
- GET `/api/agents/:id/orders` - Agent orders
- GET `/api/rewards/summary` - Reward summary
- POST `/api/rewards/:id/claim` - Claim single reward
- POST `/api/rewards/claim-all` - Claim all rewards

## WebSocket
- Server broadcasts on ws://host:5000 via upgrade handler
- Messages: `price_update` (pyth/sudo/blended prices), `agent_update` (agent state changes)
- Frontend: WSProvider context, useLivePrice() hook for real-time price display

## Running
- `npm run dev` starts the Express + Vite server on port 5000
- Database schema pushed via `npm run db:push`
- Pyth Hermes API (public, no key needed): https://hermes.pyth.network
