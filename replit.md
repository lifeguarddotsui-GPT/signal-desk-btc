# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform designed for autonomous trading of SUI-USDC perpetual contracts on Typus Finance. It features a dual-agent architecture (Execution Agent + Signal Sub-Agent), a Market Dashboard with live Pyth Oracle data and multi-timeframe charting, and the Triton Signal Engine with regime-aware AI signal generation. The platform provides a transparent and user-centric experience for deploying, managing, and monitoring AI trading agents with auditable on-chain transactions.

## User Preferences
Not specified.

## System Architecture

### Frontend
React + Vite + Tailwind CSS + shadcn/ui + Recharts. Integrates with SUI wallets via @mysten/dapp-kit. Uses wouter for routing, TanStack Query v5 for data fetching, WebSocket for real-time updates.

**Pages:** Landing (/), Market Dashboard (/dashboard), Deploy Agent (/deploy), My Agents (/my-agents), Claim Rewards (/rewards), Leaderboard (/leaderboard), Protocol (/protocol), Docs (/docs), Learn (/learn), Instructions (/instructions), Profile (/profile), Bundles (/bundles), SUI Flow (/sui-flow), Debug Ledger (/debug/ledger)

### Backend
Express.js + PostgreSQL (Drizzle ORM) + WebSocket server for real-time data.

**Key Server Modules:**
- `server/routes.ts` - API endpoints (~4500 lines)
- `server/dex/execution-engine.ts` - Trade execution, position lifecycle, close state machine
- `server/signal-engine.ts` - Triton Signal Engine with regime detection
- `server/dex/typus-adapter.ts` - Typus Perps DEX adapter with Move calls
- `server/dex/wallet-manager.ts` - Wallet encryption/decryption
- `server/dex/coin-manager.ts` - Gas coin management
- `server/learning-engine.ts` - EWMA-based learning with UCB bandit
- `server/price-service.ts` - Pyth Oracle price polling
- `server/position-monitor.ts` - Open position monitoring
- `server/market-engine.ts` - Market data processing
- `server/executor/executor-loop.ts` - Main execution loop
- `server/executor/bundle-executor.ts` - Instruction bundle execution

### Shared
- `shared/schema.ts` - Drizzle schema (17 tables), Zod insert schemas, TypeScript types
- `shared/sui-constants.ts` - On-chain addresses, package IDs, market/pool indices
- `shared/bundle.ts` - Bundle types
- `shared/indicators.ts` - Technical indicator logic

## Core Architectural Decisions & Features

### Dual-Agent System
Each deployment includes an Execution Agent (wallet, orders, positions, risk management) and a Signal Sub-Agent (indicator analysis, signal generation).

### Triton Signal Engine
Regime-aware, multi-timeframe signal engine. Detects TREND vs RANGE via ADX. Three modes:
- **AGGRESSIVE**: weakScore=30, strongScore=45, emaDistMax=4.0%, volMin=0.25x, adxTrendMin=14, minRrTrend=0.4, allowMomentumContinuation=true
- **PRECISION**: weakScore=48, strongScore=60, emaDistMax=1.0%, volMin=0.60x, adxTrendMin=20, minRrTrend=1.0, requireMacdTurnForWeak=true
- **AUTO** (default): Selects AGGRESSIVE when ADX>18 and vol>0.6, otherwise PRECISION

Weighted scoring: RSI zone, EMA distance/pullback, volume multiplier, ADX trend strength, HTF alignment (15m/1h), MACD momentum, VWAP distance, RSI recovery entries. Adaptive position sizing: 25-100% of max collateral based on score.

### Cooldowns
- TRADE_COOLDOWN: 10s
- LOSS_COOLDOWN: 30s per loss
- STREAK_LOSS_COOLDOWN: 3min for 3+ consecutive losses
- SKIP_BUNDLE_COOLDOWN: 5min
- CLOSE_COOLDOWN: 30s between close attempts
- Signal TTL: 45s

### DEX Execution Engine
Typus Perps adapter executing on-chain Move calls (create_trading_order, cancel_trading_order). Keeper-based market orders with per-position close gas caps (0.15 SUI max), dry-run preflights, and slippage control.

### Keeper Settlement Timing Protection
When close TX succeeds but Typus keeper takes >30s to fill, the system trusts price-based PnL instead of overriding with on-chain-derived PnL (which reads near-zero before settlement arrives). CollateralVerify is skipped when settlement is pending. Extended reconciliation timers (20s, 60s, 120s, 300s) catch up after keeper fills. Recovery endpoint `POST /api/recovery/sync-balance` forces full on-chain reconciliation including locked collateral in positions and pending orders, computing implied PnL from `(onChainTotal + rewardsPaid) - netDeposited`.

### Position Lifecycle State Machine
`pending_open` → `open` → `closed` with deterministic reconciliation via TX digest parsing. Two-step position_id assignment (Typus order_id on create, position_id after keeper fill). Background resolution polls on-chain.

### Close State Machine
`open` → `close_requested` → `close_order_working` → `closed` (or `manual_review` for terminal errors). DB-persisted state tracking prevents close spam. Terminal error detection:
- **order_not_found (Move abort code 5)**: Position/order gone from Typus. Pre-close on-chain existence check catches this before burning gas. If detected in dry-run or real TX, verifies on-chain, attempts position ID re-resolution if position still exists, marks as liquidated/settled if gone.
- **key_not_found**: Position ID mismatch (stored order_id vs actual position_id). Attempts re-resolution from on-chain fill events.
- **too_many_linked_orders**: Deep-cancels linked orders via wallet TX history scan, retries.
- **oracle_mismatch**: 5-minute cooldown.

### Transaction Safety & Recovery
Per-wallet transaction queue, CoinManager for gas reserves, safe-execute with retry logic, dry-run preflights. Three-layer order cleanup and orphaned order recovery.

### Anti-Liquidation Protection (3-Tier)
1. Stop-loss auto-tightening as unrealized loss grows
2. Max collateral loss cap triggers emergency close
3. Emergency close with last-resort gas budget
Daily gas caps auto-pause agents.

### Safety Systems
- Position Monitor: checks open positions
- Circuit Breaker: pauses after 3 consecutive failures (60s cooldown, auto-recovery)
- Daily Spend Cap: auto-pauses when failed gas > 0.05 SUI or 10 failed TXs
- Gas Management: two-tier policy, dynamic budgeting (10M-200M MIST), 0.03 SUI collateral reserve, 0.005 SUI absolute minimum

### Agent Ownership
Agents tied to creator's wallet via userId. Default-user agents (legacy/external wallet registrations) allow any connected wallet to manage. Delete endpoint checks: isOwner (userId match) || isCreator (wallet match) || isDefaultUser.

### Rewards
On-chain rewards escrowed for profitable position closures. Configurable reward share percentage per agent (default 50%). Calculations based on reinvestedAmount and balance-confirmed settlements.

### Portfolio Display & Chain-Derived Stats
My Agents page: on-chain-verified portfolio value, wallet balance, positions, pending orders, PnL. Unifies closed positions using chain-derived trade data merged with DB records. LiquidateEvent detection for liquidation classification. Auto-corrects DB positions falsely marked as liquidated when chain shows cancelled.

### SUI Flow Tracker
Page (/sui-flow) and API endpoint (`/api/agents/:id/sui-flow`) scans on-chain wallet transaction history, categorizes SUI movements (deposits, trade opens, close returns, cancel returns, gas), detects liquidations via LiquidateEvent. Chain-derived PnL for ground-truth accuracy.

### TX Inspector
Endpoint (`GET /api/tx/:digest/inspect`) provides detailed transaction breakdown: error classification (ORDER_NOT_FOUND, KEY_NOT_FOUND, TOO_MANY_LINKED_ORDERS, OBJECT_NOT_FOUND, OBJECT_VERSION_STALE, NOT_AUTHORIZED, INSUFFICIENT_GAS, SLIPPAGE, ALREADY_CLOSED), Move abort details, balance changes, gas costs, events.

### Learning Engine
Tracks close outcomes in `close_outcomes` table. Maintains `policy_weights` using EWMA-based reward scoring. UCB bandit algorithm for close action selection across market regimes.

### UI/UX
Dark crypto trading theme with teal primary color, CSS variable-based charting, mobile-first responsive design. Sidebar navigation with all platform pages.

## Database Tables (shared/schema.ts)
users, signalAgents, agents, signals, orders, positions (with close state machine fields: closeState, closeAttempts, lastCloseTx, closePendingSince), rewards, systemConfig, marketData, protocolFees, deposits, instructionBundles, bundleExecutions, verifiedTransactions, typusTrackedOrders, closeOutcomes, policyWeights

## External Dependencies
- **Typus Perps:** On-chain perpetuals trading protocol on SUI
- **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
- **PostgreSQL:** Relational database (Drizzle ORM)
- **Sui Blockchain:** SUI mainnet (fullnode.mainnet.sui.io)
- **Vite:** Frontend build tool
- **Tailwind CSS:** Utility-first CSS framework
- **shadcn/ui:** UI component library
- **@mysten/dapp-kit:** SUI wallet integration
- **@mysten/sui:** SUI SDK for transaction building
- **Express.js:** Backend framework
- **NaCl:** Keypair encryption (secretbox with SESSION_SECRET-derived key)
- **Recharts:** Charting library
- **wouter:** Frontend routing
- **TanStack Query v5:** Data fetching and cache management
