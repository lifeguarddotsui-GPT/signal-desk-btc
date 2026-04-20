# Blue Water Agents - Breakout Trading Engine

## Overview
Blue Water Agents is a minimal, deterministic breakout trading engine for SUI-USDC perpetual contracts on Typus Finance. The system executes a single volatility breakout strategy with fixed parameters, one position at a time, designed for real PnL evaluation with maximum debuggability.

## User Preferences
Not specified.

## System Architecture

### Design Philosophy
- **One strategy, one engine, one position at a time**
- Fixed config — no modes, no multi-strategy routing, no indicator voting
- If data is stale or missing, do nothing
- If execution verification fails, do nothing
- Hard risk gates: daily loss stop, consecutive loss stop

### Engine Configuration (server/engine/trading-config.ts)
- Leverage: 30x
- Collateral: 3–4 SUI per trade
- Take Profit: 50bps above entry (long) / below entry (short)
- Stop Loss: 35bps adverse from entry
- Max hold time: 900 seconds (15 minutes)
- Cooldown after close: 300 seconds (5 minutes)
- Daily loss stop: 2.5 SUI
- Max consecutive losses: 4

### Entry Criteria (Regime Filter + Breakout Strategy)
- ATR ratio ≥ 0.8 (recent 14-bar ATR / prior 14-bar ATR) — volatility expansion required
- Volume ratio ≥ 0.7 (rolling 5-bar avg volume / rolling 15-bar avg volume) — volume confirmation
- Both filters use rolling window averages to be robust against seeded vs. live candle scale differences
- Breakout above 20-bar high → LONG, below 20-bar low → SHORT
- Trend bias from 20-bar EMA slope (bullish / bearish / neutral) stored for analytics

### Engine Files (server/engine/)
- `trading-config.ts` — all constants, single source of truth
- `types.ts` — TradeRecord, EngineState, EntryReason, ExitReason types
- `regime-filter.ts` — ATR + volume regime evaluation
- `breakout-strategy.ts` — high/low breakout decision
- `risk-manager.ts` — canOpenNewTrade gate + computeExitPrices
- `position-manager.ts` — TP/SL/time-based close triggers
- `execution-service.ts` — wraps TypusAdapter for open/close
- `trade-journal.ts` — writes to breakout_trades table, provides getRecent + summarize
- `trading-engine.ts` — main tick loop (5s), orchestrates all components

### Infrastructure (Preserved)
- `server/dex/typus-adapter.ts` — on-chain Typus Perps execution (30x lever perps on SUI mainnet)
- `server/dex/wallet-manager.ts` — encrypted keypair management (generateAgentWallet, decryptKeypair)
- `server/dex/gas.ts` — gas reserve management
- `server/rpc-throttle.ts` — shared SuiJsonRpcClient singleton (getThrottledSuiClient)
- `server/price-service.ts` — Pyth Oracle price feed (real-time)
- `server/market-engine.ts` — candle building (15m, 5m, 1h, 4h) from price ticks
- `server/db.ts` — PostgreSQL connection via Drizzle ORM

### Agent Wallet Architecture
- On agent creation, `generateAgentWallet()` creates a fresh Ed25519 keypair on SUI mainnet
- The agent's SUI address is stored as `walletAddress` in the agents table
- The encrypted private key is stored as `agentWallet` (tweetnacl secretbox, SESSION_SECRET derived key)
- Existing agents without wallets are auto-provisioned on their next fetch
- **Deposits are real on-chain SUI transfers**: user's dapp-kit wallet → agent's SUI address
- Backend verifies the tx digest via `getTransactionBlock`, checks `balanceChanges` for the inflow to the agent address, extracts the verified amount, and prevents double-crediting by checking txDigest uniqueness
- Frontend uses `useSignAndExecuteTransaction` from `@mysten/dapp-kit` and `Transaction` from `@mysten/sui/transactions` to build and sign the transfer

### Database Tables
- `breakout_trades` — one row per trade: entry/exit price, PnL, ATR/vol at entry, exit reason
- `engine_state` — single persistent row with daily PnL, consecutive losses, cooldown, current trade ID
- Existing tables (agents, positions, etc.) retained for wallet/agent infrastructure

### API Endpoints
- `GET /api/engine/state` — current EngineState + last scan decision (regime + strategy decision)
- `GET /api/engine/trades?limit=N&agentId=X` — recent trades from journal (filtered by agent)
- `GET /api/engine/summary?agentId=X` — aggregate stats (win rate, total PnL, avg W/L)
- `POST /api/engine/toggle` — `{ enabled: boolean }` — start/stop engine
- `GET /api/market/price` — latest Pyth price tick
- `GET /api/market/candles` — 15m candle history
- `GET /api/market/state` — 24h OHLCV
- `GET /api/agents/:id/wallet-balance` — real on-chain SUI balance for agent wallet (via SUI RPC)

### UI (Single Page, 3 Tabs)
At `/` — three-tab dashboard:

**Tab 1: My Agent** (wallet-gated)
- Connect wallet prompt if no wallet connected
- "Create Agent" dialog if no agent exists for this wallet
- Market stats bar: live SUI/USD price, ATR ratio, vol ratio, trend bias, TRADEABLE/BLOCKED badge
- Connected wallet real SUI balance (via `useSuiClientQuery` from dapp-kit, live on-chain)
- Agent header: name, status badge (ACTIVE/IDLE), activate/deactivate, Configure, Deposit, Delete buttons
- Stats grid: real on-chain agent wallet balance (from SUI RPC), total PnL, trades (W/L), win rate
- Config strip: leverage, collateral range, SL/TP bps, SUI Explorer link for agent wallet
- Open Position panel (waterx-inspired): entry price, mark price, liquidation price, TP, SL, unrealized PnL, size, notional, position age, entry reason, trend at entry, SL→TP progress bar
- Trade history table with leverage column, all closed trades for this agent

**Tab 2: Rewards** (wallet-gated)
- Pending / claimed / total earned stats
- Claim All button for pending rewards
- Full reward history with per-reward claim buttons
- 10% of every winning trade's PnL accumulates as a reward

**Tab 3: Engine**
- Engine Status — state (RUNNING/STOPPED), daily PnL, consecutive losses, cooldown, last scan time
- Last Scan — regime status (TRADEABLE/BLOCKED), ATR ratio, volume ratio, trend bias
- Current Position — live position view
- Session Metrics — global trade stats
- All Recent Trades table

### Technical Stack
- Frontend: React, Vite, Tailwind CSS, shadcn/ui, wouter, TanStack Query v5
- Backend: Express.js, PostgreSQL (Drizzle ORM), TypeScript
- Chain: SUI mainnet, Typus Finance perps, Pyth Oracle (Hermes API)

## External Dependencies
- **Typus Perps:** On-chain perpetuals trading protocol on SUI
- **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
- **PostgreSQL:** Relational database
- **Sui Blockchain:** SUI mainnet
