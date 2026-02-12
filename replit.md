# Lifeguard.sui - AI Trading Platform

## Overview
Web3 AI trading platform where AI agents autonomously trade SUI-PERP perpetual contracts with verifiable on-chain transactions. Features a Market Dashboard with live Pyth Oracle + Sudo Finance price feeds, enhanced indicators (Connors RSI, RSI Divergence, DEMA, TEMA), Deploy Agent with funding flow and protocol fees, Claim Rewards with wallet verification, and WebSocket real-time updates. No seed/fake data - all agents must be user-created and funded with verifiable transactions.

## Architecture
- **Frontend**: React + Vite + Tailwind + shadcn/ui + Recharts + @mysten/dapp-kit (SUI wallet)
- **Backend**: Express.js with PostgreSQL (Drizzle ORM) + WebSocket server
- **Price Service**: Live Pyth Oracle (primary) + Sudo Finance (secondary) with blended pricing
- **Indicators**: shared/indicators.ts - Connors RSI, DEMA, TEMA, RSI Divergence
- **Signal Engine**: Score-based (3-of-6 conditions) for long/short signal generation
- **Theme**: Dark crypto trading theme with teal primary color (hsl 173 80% 40%), chart colors use CSS variables (--chart-1 through --chart-5) for light/dark theme compatibility
- **Protocol Fee**: 2% on all agent deposits, sent to 0xf407...13d6 (Blue Water Digital)
- **SUI Verification**: On-chain tx verification via SuiJsonRpcClient (mainnet), real-time balance checking

## Key Files
- `shared/schema.ts` - Data models (users, agents, signals, orders, positions, rewards, marketData, protocolFees, verifiedTransactions)
- `shared/indicators.ts` - Connors RSI, DEMA, TEMA, RSI Divergence calculations
- `server/routes.ts` - API endpoints
- `server/storage.ts` - Database storage layer (IStorage interface)
- `server/market-engine.ts` - Market data engine with live price service
- `server/price-service.ts` - Pyth Oracle + Sudo Finance price fetching
- `server/sui-verify.ts` - SUI transaction verification service (on-chain validation, balance checking)
- `client/src/pages/market-dashboard.tsx` - Market Dashboard with live charts/indicators, Sudo chart embed
- `client/src/pages/deploy-agent.tsx` - Deploy Agent with funding dialog, protocol fees, txDigest verification
- `client/src/pages/claim-rewards.tsx` - Claim Rewards page with txDigest for on-chain verification
- `client/src/components/wallet-balance.tsx` - Real-time on-chain SUI balance display
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
- POST `/api/agents/:id/deposit` - Deposit SUI to agent (2% protocol fee applied, optional txDigest)
- GET `/api/agents/:id/positions` - Agent positions
- GET `/api/agents/:id/orders` - Agent orders
- GET `/api/balance/:address` - Real-time on-chain SUI balance for any address
- POST `/api/tx/track` - Track and verify a SUI transaction on-chain
- POST `/api/tx/verify` - Verify a transaction digest
- GET `/api/rewards/summary` - Reward summary
- POST `/api/rewards/:id/claim` - Claim single reward (optional txDigest)
- POST `/api/rewards/claim-all` - Claim all rewards (optional txDigest)

## WebSocket
- Server broadcasts on ws://host:5000 via upgrade handler
- Messages: `price_update` (pyth/sudo/blended prices), `agent_update` (agent state changes)
- Frontend: WSProvider context, useLivePrice() hook for real-time price display

## Design Decisions
- All agents start with 0 SUI balance and must be funded before trading
- Deposits optionally accept txDigest for on-chain verification; only verified if tx confirmed
- No seed/mock data - platform shows empty states until real agents are created
- Mobile-first responsive design with 2-col grid on mobile, 4-col on desktop
- Charts use CSS variable-based colors (useChartColors hook) for theme compatibility

## Running
- `npm run dev` starts the Express + Vite server on port 5000
- Database schema pushed via `npm run db:push`
- Pyth Hermes API (public, no key needed): https://hermes.pyth.network
