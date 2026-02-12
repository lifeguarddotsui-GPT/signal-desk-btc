# Blue Water Agents - AI Trading Platform

## Overview
Web3 AI trading platform with dual-agent architecture where execution agents are paired with signal sub-agents that autonomously trade SUI-PERP perpetual contracts. Features a Market Dashboard with live Pyth Oracle data, professional CoinMarketCap-style candlestick chart with EMA overlays, RSI/MACD panels, AI Signal Reasoning panel showing condition-by-condition thinking process, Deploy Agent with execution + signal agent pairing and real DEX execution via SDK adapters, Claim Rewards with wallet-signed on-chain transactions, Landing page, Instructions page, Profile page, and WebSocket real-time updates. No seed/fake data - all agents must be user-created and funded with verifiable on-chain transactions.

## Architecture
- **Frontend**: React + Vite + Tailwind + shadcn/ui + Recharts + @mysten/dapp-kit (SUI wallet)
- **Backend**: Express.js with PostgreSQL (Drizzle ORM) + WebSocket server
- **Dual-Agent System**: Each deployed agent consists of an Execution Agent paired with a Signal Sub-Agent
  - Execution Agent: Manages wallet, balance, orders, positions, risk parameters
  - Signal Sub-Agent: Runs indicator analysis (momentum strategy), generates trading signals (3-of-6 conditions)
  - Signal agents are auto-created when an execution agent is deployed
- **DEX Execution Engine**: Modular adapter system for on-chain trade execution
  - Common adapter interface (DexAdapter) for all venues
  - Sudo Finance adapter: Perpetual trading via Move contract calls
  - Typus Finance adapter: Perpetual trading via Move contract calls
  - FlowX Finance adapter: Spot DEX swap execution via Move contract calls
  - ZoFAI adapter: Stub (SDK not yet available for SUI mainnet)
  - Execution engine converts signals to on-chain trades with idempotency
  - Agent wallets generated with Ed25519Keypair, encrypted at rest via NaCl secretbox
- **Price Service**: Live Pyth Oracle (primary) + Sudo Finance (secondary) with blended pricing
- **Indicators**: shared/indicators.ts - Connors RSI, DEMA, TEMA, RSI Divergence
- **Signal Engine**: Score-based (3-of-6 conditions) for long/short signal generation, per signal agent
- **Theme**: Dark crypto trading theme with teal primary color (hsl 173 80% 40%), chart colors use CSS variables (--chart-1 through --chart-5) for light/dark theme compatibility
- **Protocol Fee**: 2% on all agent deposits, sent to 0xf407...13d6 (Blue Water Digital)
- **SUI Verification**: On-chain tx verification via SuiJsonRpcClient (mainnet), real-time balance checking

## Key Files
- `shared/schema.ts` - Data models (users, agents, signalAgents, signals, orders, positions, rewards, marketData, protocolFees, verifiedTransactions)
- `shared/indicators.ts` - Connors RSI, DEMA, TEMA, RSI Divergence calculations
- `server/routes.ts` - API endpoints (returns AgentWithSignalAgent for agent queries)
- `server/storage.ts` - Database storage layer (IStorage interface with signal agent CRUD)
- `server/market-engine.ts` - Market data engine with live price service, generates signals per signal agent, triggers execution engine
- `server/price-service.ts` - Pyth Oracle + Sudo Finance price fetching
- `server/sui-verify.ts` - SUI transaction verification service (on-chain validation, balance checking)
- `server/dex/types.ts` - DEX adapter interface, order/position types, venue config
- `server/dex/index.ts` - Adapter registry, exports all adapters and wallet manager
- `server/dex/execution-engine.ts` - Signal-to-trade conversion, order lifecycle, position reconciliation
- `server/dex/wallet-manager.ts` - Secure keypair generation, encryption/decryption via NaCl
- `server/dex/sudo-adapter.ts` - Sudo Finance perpetual trading adapter
- `server/dex/typus-adapter.ts` - Typus Finance perpetual trading adapter
- `server/dex/flowx-adapter.ts` - FlowX Finance spot DEX swap adapter
- `server/dex/astros-adapter.ts` - Astros Perps adapter (REST API with Ed25519 wallet signing)
- `server/dex/zofai-adapter.ts` - ZoFAI stub adapter (SDK pending)
- `client/src/pages/market-dashboard.tsx` - Market Dashboard focused on AI Signal Reasoning with score visualization, condition cards, live indicators, and agent broadcast status
- `client/src/pages/deploy-agent.tsx` - Deploy Agent with dual-agent display, DEX venue status, auto-trade toggle, funding dialog
- `client/src/pages/claim-rewards.tsx` - Claim Rewards page with txDigest for on-chain verification
- `client/src/pages/landing.tsx` - Landing page with hero section and features overview
- `client/src/pages/instructions.tsx` - 6-step usage guide
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
- DELETE `/api/agents/:id` - Delete agent with cascading cleanup (signals, orders, positions, signal agent)
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
- Messages: `price` (pyth/sudo/blended prices), `agent:created`, `agent:updated`
- Frontend: WSProvider context, useLivePrice() hook for real-time price display

## DEX Integration
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

## Running
- `npm run dev` starts the Express + Vite server on port 5000
- Database schema pushed via `npm run db:push`
- Pyth Hermes API (public, no key needed): https://hermes.pyth.network
