# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform focused on autonomous trading of SUI-USDC perpetual contracts on Typus Finance. Its core purpose is to provide a transparent and user-centric environment for deploying, managing, and monitoring AI trading agents in decentralized finance. Key capabilities include auditable on-chain transactions, a dual-agent architecture, a comprehensive Market Dashboard utilizing live Pyth Oracle data, and the Triton Signal Engine for regime-aware AI signal generation. The project aims to empower users with advanced AI-driven trading strategies and capitalize on the growth of the DeFi market.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for dynamic charting. Navigation is sidebar-based.

### Core Architectural Decisions & Features
The system employs a **dual-agent architecture**, separating the **Execution Agent** (trade execution) from the **Signal Sub-Agent** (market analysis). A **DEX Execution Engine** integrates with Typus Perps using on-chain Move calls, incorporating resilience for RPC issues, gas management, and slippage control.

**Position Management** includes comprehensive lifecycle transitions, deterministic reconciliation, and an emergency close priority system. A **Write-Ahead Log (WAL)** pattern creates DB position records before on-chain transaction submission. Transaction safety is ensured via per-wallet transaction queues, gas management, dry-run preflights, and recovery mechanisms. **Anti-liquidation protection** features a multi-tier system including stop-loss auto-tightening, max collateral loss caps, active close verification, and a rapid monitor for approaching thresholds.

A **Dual-Position Architecture** allows each agent to hold up to two simultaneous positions for hedging or doubling-down, with smart gating for second position opening. Agent ownership is linked to user wallets with configurable reward shares and a dynamic **Reward Model**.

The **Dual-Wallet Architecture** assigns each agent a **Funding Wallet** for trades and gas, and a **Savings Wallet** for accumulating a portion of trading profits. Profits are split between reward escrow, savings wallet, and funding wallet. The **On-Chain Portfolio** displays "Invested," "Funding Wallet," and "Savings Wallet," with PnL computed server-side using Pyth Oracle data. PnL tracking includes a **PnL Gain Cap** and **PnL Transition Stabilization**.

**Post-Close Coin Merge** automatically merges fragmented SUI coins. **Periodic Balance Reconciliation** corrects discrepancies. **Runtime Zombie Position Recovery** re-opens DB entries for untracked on-chain positions. **Stale Close Recovery** retries stuck close operations. **Contradictory State Healing** repairs impossible position states.

An **On-Chain PnL Audit System** runs in the background, verifying closed position PnL against actual on-chain transaction data.

**Reconciliation Architecture** uses a backend-first canonical portfolio state machine that runs periodically, computing a full decomposed portfolio snapshot. This utilizes new DB tables: `position_journal`, `fund_flow_ledger`, and `portfolio_snapshots`.

**Dynamic SL/TP System**: Each agent operates on a personalized exit strategy range (SL: 25–50bps, TP: 50–100bps) computed by the Capital Plan based on win rate, consecutive streaks, and gas pressure. Agents close positions *early* (within the soft zone) when market conditions confirm: profit decay (2+ consecutive declining ticks), opposing signal strength (≥65 score), position age (15min+), or high-aggression mode. The `DynamicSlTp` struct is part of the `CapitalPlan` and exposed to the frontend, which displays the mode label, ranges, and early-close aggression level. The execution engine now uses `slSoftBps/slHardBps` and `tpSoftBps/tpHardBps` instead of static configured values.

**Effective SL Transparency** ensures users are aware of how maximum collateral loss caps impact effective stop-loss at high leverage. **Phantom Position Filtering** uses multi-layered defenses to prevent misidentification of closed positions and collateral inflation. **Position Lifecycle Tracking** ensures all closed positions display in the UI. **PnL Gap Reconciliation** distributes PnL discrepancies. **Liquidation Detection** corrects PnL for liquidated positions. A "Close All Positions" endpoint allows bulk closing.

**Gas conservation** is critical, with a **Capital Preservation System** and a **Gas Cap Safety System** using a graduated throttle. Gas tracking charges only for operations submitting actual on-chain transactions.

The **Learning Engine** tracks trade outcomes, maintains per-agent policy weights, and employs a UCB bandit algorithm for close action selection. The **Capital Plan system** is collateral-aware and adapts to growth/drawdowns. **Regime blocking** and **adaptive score thresholds** prevent unprofitable trading. The **Triton Signal Engine** is regime-aware, generating signals across multiple timeframes.

A **Gas Top-Off System** provides agent wallet refilling. **Fast Position Display** ensures real-time UI updates, and a **Position Close Priority System** sorts close operations. **Portfolio Value Stabilization** prevents balance flickering. **On-Chain Position Recovery** provides descriptive messaging, and **Automatic Position Recovery** auto-reopens force-settled closed DB positions that are still open on-chain. **Cancelled Position PnL Correction** ensures `cancelled_unfilled` positions have 0 PnL.

An **Open Code Tab** provides transparency. The **Learning Engine Dashboard** displays "Win Rate." The **Protocol Wallet On-Chain Balance** is displayed live. **Reward Claiming** allows users to claim escrowed rewards. An **About Blue Water AI** page provides educational content.

The **SUI Flow Tracker** reconstructs on-chain transaction history for accounting transparency. The SUI Flow page includes an **Accounting Breakdown** waterfall. **Keeper Close Detection** scans recent wallet transactions to extract actual SUI balance changes for real PnL computation for positions closed by the Typus keeper.

**PnL Forensic Repair** (F001-F004): Fixed a critical accounting inconsistency where "Realized Losses" (from stale `agent.totalPnl`) was overcounting losses by 15-20 SUI vs the portfolio-math truth. Root cause: `agent.totalPnl` accumulates price-estimated per-close PnL via `atomicUpdateAgentAfterClose` which drifts over time. Fix: The canonical snapshot now derives `realizedPnl = portfolioTotalPnl - max(0, unrealizedPnl)` from economic value math (always internally consistent). The reconciliation engine corrects `agent.totalPnl` every 5s (no chain-data dependency). A new `GET /api/agents/:id/forensics` endpoint provides per-position PnL audit with confidence tiers (on-chain | synthetic | price-estimated | cancelled), invariant checks, and duplicate tx detection. The WalletSummaryPanel now shows an expandable "PnL Breakdown" with realized/unrealized/total decomposition, invariant pass/fail, and per-agent drift warnings. The `pnlStatus` field now reflects data freshness rather than overcounting-inflated coverage %.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit, and wouter, utilizing TanStack Query v5 for data fetching and WebSockets. The backend uses Express.js and PostgreSQL (Drizzle ORM), featuring API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet/coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic.

**Performance Tracker**: A backend time-series analytics system (`server/performance-tracker.ts`) that snapshots portfolio economic value, PnL, regime, win rate, open positions, and signal data every 5 minutes into the `performance_log` PostgreSQL table (7-day retention). A `classifyLossReason()` function flags counter-trend trades, range-chop, low win rate, overexposure, and consecutive losses. `getLossAnalysis()` aggregates top loss drivers, regime EV deltas, recent trend direction, and produces a plain-English recommendation. API endpoints: `GET /api/performance/log?interval=5m|15m|30m|1h|4h|24h` and `GET /api/performance/analysis`. Frontend: `client/src/components/PerformanceTracker.tsx` — collapsible panel on the My Agents page showing trend indicator, top loss driver, recommendation, EV/PnL area chart with interval toggle, regime performance breakdown, and top 3 loss drivers by EV lost.

**Open Position Display Fix**: `FundStatus` component now uses `ACTIVE_STATUSES = ["open", "pending_open", "closing", "pending_close"]` to ensure guardian-tracked positions in `closing` state remain visible in the agent card. A smart fallback prevents display flicker: if fast-poll returns empty but activity has open positions, the activity data is used instead.

## External Dependencies
-   **Typus Perps:** On-chain perpetuals trading protocol on SUI
-   **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
-   **PostgreSQL:** Relational database
-   **Sui Blockchain:** SUI mainnet