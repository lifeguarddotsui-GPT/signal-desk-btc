# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform enabling autonomous trading of SUI-USDC perpetual contracts on Typus Finance. The platform features a dual-agent architecture, a Market Dashboard with live Pyth Oracle data and multi-timeframe charting, and the Triton Signal Engine for regime-aware AI signal generation. Its primary purpose is to provide a transparent and user-centric experience for deploying, managing, and monitoring AI trading agents with auditable on-chain transactions, empowering users with advanced AI-driven trading strategies in decentralized finance.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for charting. Navigation is managed via a sidebar.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit for SUI wallet integration, and wouter for routing. Data fetching uses TanStack Query v5, with WebSockets for real-time updates.

The backend uses Express.js and PostgreSQL (Drizzle ORM), with a WebSocket server for real-time data. Key backend components include API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet and coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic.

### Core Architectural Decisions & Features

**Dual-Agent System:** Each deployment includes an Execution Agent for trade execution, position, and risk management, and a Signal Sub-Agent for market analysis and signal generation.

**Trading & Risk Management:** Implements dynamic trailing stop-loss, ATR-based dynamic stop-loss, dynamic take-profit extension for strong trends, and position-age SL tightening. Emergency closes are prioritized to prevent liquidation. The system includes circuit breakers, cooldowns, and retry mechanisms for robust operation.

**DEX Execution Engine:** Integrates with Typus Perps via on-chain Move calls, utilizing a keeper-based system for market orders with gas caps, dry-run preflights, and slippage control. It incorporates comprehensive resilience against RPC rate-limiting and 429 errors. A global RPC throttle (`server/rpc-throttle.ts`) limits all SUI RPC calls to 3 concurrent requests with a 15s queue timeout — all SUI client instances (execution engine, typus adapter, startup integrity, sui-verify, zo-adapter, routes) use the shared throttled client via `getThrottledSuiClient()`. The position monitor processes agents sequentially with 800ms delays between agents (10s tick interval) to prevent burst RPC storms. On-chain position queries are cached (5s TTL) to reduce RPC load. When `getPositions` returns empty due to 429 errors, the result is tagged with `__rateLimited=true` so consumers can fall back to DB positions instead of showing 0 locked collateral. Agents auto-pause on INSUFFICIENT_GAS during close attempts (instead of retry-spamming) and auto-resume after 60s gas re-check when wallet is topped up. Gas reserves are defined in `server/dex/gas.ts` (single source of truth): `COLLATERAL_GAS_RESERVE_SUI = 1.0` base reserve + `GAS_PER_CLOSE_SUI = 0.15` per open position, ensuring agents keep 1-2 free SUI for gas and closing operations.

**Position Lifecycle Management:** Positions transition through `pending_open`, `open`, and `closed` states, with deterministic reconciliation via transaction digest parsing. An emergency close priority system ensures critical closes bypass standard safety barriers.

**Transaction Safety & Recovery:** Features per-wallet transaction queues, gas management via CoinManager, safe-execute logic with retries, and dry-run preflights. Comprehensive order cleanup and recovery mechanisms are in place. Startup integrity checks clean up bogus recovery positions, detect untracked on-chain positions, and void duplicate/bogus pending rewards.

**Reward Deduplication:** Rewards are gated by a per-position dedup check — `getRewardsByPositionId()` prevents creating multiple rewards for the same position. The `positionGoneFromDex` settlement path only fires when `closeTxWasAttempted` is true, preventing false-positive settlements from RPC 429 failures. Startup integrity voids duplicate pending rewards and rewards for still-open positions.

**Anti-Liquidation Protection:** A three-tier system involving stop-loss auto-tightening, a max collateral loss cap, and last-resort emergency closes with dedicated gas budgets. Daily gas caps auto-pause agents. False liquidation prevention requires two-factor verification.

**Agent Ownership & Rewards:** Agents are linked to user wallets, with on-chain rewards escrowed for profitable closures and configurable reward shares.

**Profit Retention System:** Each agent has `profitRetentionPct` (0-50%, default 10%) and `retainedProfits` (accumulated SUI). After each profitable close, `retentionPct%` of realized PnL is added to `retainedProfits`. This acts as a locked savings bucket — subtracted from usable collateral in position sizing (`totalReserve = dynamicGasReserve + retainedProfits`) so it grows free SUI over time without being risked. **RetainedProfits is auto-capped** to never exceed the agent's actual wallet balance — if freeSui drops below retainedProfits (due to losses), the DB value is auto-corrected to match freeSui. Retention is **suspended** when freeSui < `COLLATERAL_GAS_RESERVE_SUI + 0.5` to prioritize gas growth. The frontend shows "Retained Savings" in the On-Chain Portfolio section and provides a percentage selector in the Configuration section. The PATCH `/api/agents/:id` endpoint validates retention between 0-50%.

**Free SUI Display:** "Free SUI" (the agent's on-chain wallet balance available for trading/gas) is displayed consistently across all three pages: Deploy Agents (stats grid), My Agents (On-Chain Portfolio section), and SUI Flow (summary card + flow diagram). The label is always "Free SUI" with emerald green styling. All three pages now query the same `/api/agents/on-chain-portfolio` endpoint (10s poll, 8s stale) as the authoritative source for Free SUI and Portfolio values.

**Portfolio Display & Chain-Derived Stats:** All portfolio values and statistics are computed server-side using Pyth Oracle data. Portfolio value is computed as `walletBalance + lockedCollateral + pendingOrderCollateral` — directly on-chain verifiable. The dedicated `/api/agents/on-chain-portfolio` endpoint is the single source of truth for portfolio display — it queries the chain directly (wallet balance via RPC + positions via Typus events) with a 10s cache, and NEVER writes to the DB. When RPC fails or returns empty due to 429, the endpoint falls back to: (1) DB open positions (when on-chain returns 0 but DB has open positions), (2) cached on-chain positions, then (3) DB open positions again — ensuring portfolio never drops to wallet-only values during 429 storms. The frontend polls this endpoint exclusively for portfolio values (free SUI, locked collateral, portfolio value, unrealized PnL) with zero DB fallbacks. PnL is trade-based (sum of realized position PnLs + unrealized - gas), never derived from balance equations. Only the chain-derived trade-pair matching (from `computeChainDerivedStats`) can update the DB PnL — balance reconciliation systems only correct the `balance` field, not `totalPnl`. Auto-correction is gated by a 5-minute cooldown per agent and only applies from freshly computed (not cached) chain-derived data. Inferred `totalDeposited` is persisted to the DB on first computation. The activity endpoint uses stale chain-derived cache as fallback when fresh computation fails, preventing SUI Flow from showing zeros during RPC outages.

**Learning Engine:** Tracks trade outcomes, maintains per-agent policy weights using EWMA-based reward scoring, and employs a UCB bandit algorithm for close action selection. It incorporates entry pattern feedback and PnL-aware reward scoring. Close failure diagnostics classify and track failures to inform pre-emptive actions.

**Triton Signal Engine:** A regime-aware engine generating signals across multiple timeframes, detecting TREND vs. RANGE markets. It operates in AGGRESSIVE, PRECISION, or AUTO modes, each with tailored thresholds and sizing logic, including specific rules for strong trend extensions and range breakdowns/breakouts.

**Gas Top-Off System:** Each agent card on the Deploy page has a "Gas 0.5" button that sends 0.5 SUI directly from the user's connected wallet to the agent wallet — no protocol fee, instant gas refill. A "Gas Top-Off All Agents" button appears above the grid when any agents have < 0.2 SUI free, sending 0.5 SUI to all low-gas agents in a single transaction. The `/api/agents/:id/gas-topoff` endpoint records the top-off and auto-resumes agents that were paused due to INSUFFICIENT_GAS.

**Fast Position Display:** A dedicated lightweight endpoint and WebSocket events provide real-time, on-chain verified position data for immediate UI updates.

**Position Close Priority System:** When multiple positions require closing, they are sorted by a multi-factor priority system based on urgency (e.g., liquidation prevention, max collateral loss, stop-loss, take-profit) and risk scores.

## External Dependencies
- **Typus Perps:** On-chain perpetuals trading protocol on SUI
- **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
- **PostgreSQL:** Relational database
- **Sui Blockchain:** SUI mainnet
- **Vite:** Frontend build tool
- **Tailwind CSS:** Utility-first CSS framework
- **shadcn/ui:** UI component library
- **@mysten/dapp-kit:** SUI wallet integration
- **@mysten/sui:** SUI SDK
- **Express.js:** Backend framework
- **NaCl:** Keypair encryption
- **Recharts:** Charting library
- **wouter:** Frontend routing
- **TanStack Query v5:** Data fetching and cache management