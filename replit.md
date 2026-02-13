# Blue Water Agents - AI Trading Platform

## Overview
Web3 AI trading platform with dual-agent architecture where execution agents are paired with signal sub-agents that autonomously trade SUI-PERP perpetual contracts. Features a Market Dashboard with live Pyth Oracle data, professional CoinMarketCap-style candlestick chart with EMA overlays, RSI/MACD panels, AI Signal Reasoning panel showing condition-by-condition thinking process, Deploy Agent with execution + signal agent pairing and real DEX execution via SDK adapters, My Agents page with agent thinking process display, orders/positions/signals tabs, and live PnL, Claim Rewards with wallet-signed on-chain transactions (filtered to only show verified on-chain claims), Protocol Overview page showing fee collection and platform stats, Leaderboard for top agents and users, Documentation page, Landing page, Instructions page, Profile page, and WebSocket real-time updates. No seed/fake data - all agents must be user-created and funded with verifiable on-chain transactions. Custom logo generated for branding.

## Architecture
- **Frontend**: React + Vite + Tailwind + shadcn/ui + Recharts + @mysten/dapp-kit (SUI wallet)
- **Backend**: Express.js with PostgreSQL (Drizzle ORM) + WebSocket server
- **Dual-Agent System**: Each deployed agent consists of an Execution Agent paired with a Signal Sub-Agent
  - Execution Agent: Manages wallet, balance, orders, positions, risk parameters
  - Signal Sub-Agent: Runs indicator analysis (momentum strategy), generates trading signals (3-of-6 conditions)
  - Signal agents are auto-created when an execution agent is deployed
- **DEX Execution Engine**: Modular adapter system for on-chain trade execution
  - Common adapter interface (DexAdapter) for all venues
  - Typus Finance adapter: Perpetual trading via Move contract calls
  - Astros Perps adapter: REST API with Ed25519 wallet signing authentication
  - Execution engine converts signals to on-chain trades with idempotency
  - Agent wallets generated with Ed25519Keypair, encrypted at rest via NaCl secretbox
- **Price Service**: Live Pyth Oracle pricing
- **Indicators**: shared/indicators.ts - Connors RSI, DEMA, TEMA, RSI Divergence
- **Signal Engine**: Score-based (3-of-6 conditions) for long/short signal generation, per signal agent
- **Theme**: Dark crypto trading theme with teal primary color (hsl 173 80% 40%), chart colors use CSS variables (--chart-1 through --chart-5) for light/dark theme compatibility
- **Protocol Fee**: 2% on all agent deposits, sent to 0xf407...13d6 (Blue Water Digital)
- **SUI Verification**: On-chain tx verification via SuiJsonRpcClient (mainnet), real-time balance checking
- **Primary Domain**: bluewaterai.app (set via Replit Publishing > Domains)
- **Agent Ownership**: Agents are tied to creator's wallet address; only the owner can delete, active agents cannot be deleted

## Key Files
- `shared/schema.ts` - Data models (users, agents, signalAgents, signals, orders, positions, rewards, marketData, protocolFees, verifiedTransactions)
- `shared/indicators.ts` - Connors RSI, DEMA, TEMA, RSI Divergence calculations
- `server/routes.ts` - API endpoints (returns AgentWithSignalAgent for agent queries)
- `server/storage.ts` - Database storage layer (IStorage interface with signal agent CRUD)
- `server/market-engine.ts` - Market data engine with live price service, generates signals per signal agent, triggers execution engine
- `server/price-service.ts` - Pyth Oracle price fetching
- `server/sui-verify.ts` - SUI transaction verification service (on-chain validation, balance checking)
- `server/dex/types.ts` - DEX adapter interface, order/position types, venue config
- `server/dex/index.ts` - Adapter registry, exports all adapters and wallet manager
- `server/dex/execution-engine.ts` - Signal-to-trade conversion, order lifecycle, position reconciliation
- `server/dex/wallet-manager.ts` - Secure keypair generation, encryption/decryption via NaCl
- `server/dex/typus-adapter.ts` - Typus Finance perpetual trading adapter
- `server/dex/astros-adapter.ts` - Astros Perps adapter (REST API with Ed25519 wallet signing)
- `client/src/pages/market-dashboard.tsx` - Market Dashboard focused on AI Signal Reasoning with score visualization, condition cards, live indicators, and agent broadcast status
- `client/src/pages/my-agents.tsx` - My Agents page with agent thinking process, orders, positions, signals tabs, live PnL
- `client/src/pages/deploy-agent.tsx` - Deploy Agent with dual-agent display, DEX venue status, auto-trade toggle, funding dialog
- `client/src/pages/claim-rewards.tsx` - Claim Rewards page with txDigest for on-chain verification (filters non-verifiable data)
- `client/src/pages/protocol.tsx` - Blue Water Protocol overview page (fees collected, platform stats)
- `client/src/pages/leaderboard.tsx` - Leaderboard for top agents (by PnL) and top users (by rewards)
- `client/src/pages/docs.tsx` - Documentation page (architecture, financial model, developer goals)
- `client/src/pages/landing.tsx` - Landing page with hero section, custom logo, and features overview
- `client/src/pages/instructions.tsx` - 8-step usage guide (includes auto-trade, rewards, withdrawal)
- `client/src/pages/profile.tsx` - User profile with wallet and agent info
- `client/src/components/wallet-balance.tsx` - Real-time on-chain SUI balance display
- `client/src/components/app-sidebar.tsx` - Sidebar navigation
- `client/src/lib/ws-context.tsx` - WebSocket context for real-time price updates
- `client/src/lib/seo.tsx` - SEO helper hook

## Database Tables
- `users` - Wallet-based user accounts
- `agents` - Execution agents with wallet, balance, risk params, signalAgentId reference, autoTrade flag
- `signal_agents` - Signal sub-agents with strategy, indicators, threshold, signal history
- `signals` - Trading signals (global + per signal agent)
- `orders` - Trade orders linked to agents and signals, with venue and txDigest
- `positions` - Open/closed positions with on-chain txDigest
- `rewards` - Trading rewards with claim status
- `market_data` - Price snapshots
- `protocol_fees` - Fee records
- `verified_transactions` - On-chain verified tx records

## API Routes
- GET `/api/market` - Current market data (with priceSource field)
- GET `/api/market/history` - Price history (60 points)
- GET `/api/market/indicators` - RSI/Connors RSI/EMA/DEMA/TEMA indicator history
- GET `/api/market/candles` - 15m candlestick history
- GET `/api/signals` - Latest trading signals with signalScore (e.g. "L2/S3")
- GET `/api/signals/reasoning` - Real-time signal reasoning with condition-by-condition breakdown
- GET `/api/venues` - List all DEX venue adapters with SDK status
- GET `/api/venues/:venue/fees` - Fee estimates for a specific venue
- GET `/api/agents` - List agents with signal agents (AgentWithSignalAgent[])
- POST `/api/agents` - Create execution agent + auto-paired signal sub-agent + wallet
- PATCH `/api/agents/:id` - Update agent status or autoTrade flag
- DELETE `/api/agents/:id?wallet=<address>` - Delete agent (requires wallet ownership, blocks active agents)
- POST `/api/agents/:id/deposit` - Deposit SUI to agent (2% protocol fee applied, optional txDigest)
- POST `/api/agents/:id/withdraw` - Withdraw SUI from agent wallet to user wallet (on-chain transfer signed by agent keypair)
- GET `/api/agents/:id/positions` - Agent positions (all open + closed)
- GET `/api/agents/:id/orders` - Agent orders (all statuses)
- GET `/api/agents/:id/signals` - Agent-specific signal history
- GET `/api/agents/:id/activity` - Combined agent activity (orders, positions, signals, reasoning)
- GET `/api/balance/:address` - Real-time on-chain SUI balance for any address
- POST `/api/tx/track` - Track and verify a SUI transaction on-chain
- POST `/api/tx/verify` - Verify a transaction digest
- GET `/api/rewards/summary` - Reward summary
- POST `/api/rewards/:id/claim` - Claim single reward (optional txDigest)
- POST `/api/rewards/claim-all` - Claim all rewards (optional txDigest)
- GET `/api/protocol/overview` - Protocol overview (fees, deposits, rewards, agent/user counts)
- GET `/api/leaderboard` - Leaderboard data (top agents by PnL, top users by rewards)

## WebSocket
- Server broadcasts on ws://host:5000 via upgrade handler
- Messages: `price` (pyth prices), `agent:created`, `agent:updated`
- Frontend: WSProvider context, useLivePrice() hook for real-time price display

## DEX Integration
- **Supported Venues**: Typus Finance (Move contract calls), Astros Perps (REST API + Ed25519 wallet signing)
- **Execution Flow**: Signal generated -> Execution engine checks autoTrade + balance -> Routes to venue adapter -> Builds SUI transaction -> Signs with agent keypair -> Submits on-chain -> Records txDigest + updates order/position
- **Idempotency**: 60s cooldown per agent per signal direction, activeExecutions set prevents concurrent execution
- **Position Management**: Auto stop-loss/take-profit checking on each tick, position reconciliation with on-chain data
- **Wallet Security**: Ed25519 keypairs encrypted with NaCl secretbox, key derived from SESSION_SECRET, never exposed via API

## Design Decisions
- Dual-agent architecture: Every execution agent is auto-paired with a signal sub-agent
- Signal agents use momentum strategy with configurable threshold (default 3-of-6 conditions)
- All agents start with 0 SUI balance and must be funded before trading
- Deposits optionally accept txDigest for on-chain verification; only verified if tx confirmed
- No seed/mock data - platform shows empty states until real agents are created
- Candlestick chart: Canvas-based with EMA tolerance filtering to prevent Y-axis distortion
- Mobile-first responsive design with 2-col grid on mobile, 4-col on desktop
- Charts use CSS variable-based colors (useChartColors hook) for theme compatibility
- Rewards auto-generated from profitable position closes (realizedPnl > 0 creates pending reward record)
- Withdrawal: Agent keypair signs on-chain SUI transfer from agent wallet to user wallet (POST /api/agents/:id/withdraw)
- Claim rewards no longer requires agent to be running (rewards from stopped agents can still be claimed)
- Removed venues: Sudo Finance (migrated to ZO, no new positions since 1/1/2026), FlowX (spot only), ZoFAI (SDK pending)

## Running
- `npm run dev` starts the Express + Vite server on port 5000
- Database schema pushed via `npm run db:push`
- Pyth Hermes API (public, no key needed): https://hermes.pyth.network
