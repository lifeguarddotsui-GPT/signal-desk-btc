# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform facilitating autonomous trading of SUI-USDC perpetual contracts on Typus Finance. It features a dual-agent architecture (Execution Agent + Signal Sub-Agent), a Market Dashboard with live Pyth Oracle data and multi-timeframe charting, and the Triton Signal Engine for regime-aware AI signal generation. The platform provides a transparent and user-centric experience for deploying, managing, and monitoring AI trading agents with auditable on-chain transactions. The project aims to empower users with advanced AI-driven trading strategies in the decentralized finance space.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a dark crypto trading theme with a teal primary color, utilizing CSS variables for charting. It is designed to be mobile-first and responsive. Navigation is handled via a sidebar, providing access to all platform pages.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, and Recharts, integrating with SUI wallets via @mysten/dapp-kit and using wouter for routing. Data fetching is managed by TanStack Query v5, with WebSockets for real-time updates.

The backend is powered by Express.js and PostgreSQL (using Drizzle ORM), augmented by a WebSocket server for real-time data. Key backend components include API endpoints, a DEX execution engine for trade management, the Triton Signal Engine for AI signal generation, a Typus Perps DEX adapter for on-chain interactions, wallet and coin managers, a learning engine, a price service polling Pyth Oracle, and a position monitor.

A shared layer defines Drizzle schemas, Zod insert schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic.

### Core Architectural Decisions & Features

**Dual-Agent System:** Each deployment comprises an Execution Agent for trade execution, position management, and risk control, and a Signal Sub-Agent for market analysis and signal generation.

**Trading & Risk Management:** Features include dynamic trailing stop-loss (breakeven at +15bps, trailing at peak-20bps from +30bps), ATR-based dynamic stop-loss (narrowing only, 1.2x ATR multiplier), dynamic take-profit extension for strong trends (1.25x at ADX>25, 1.35x at ADX>30), and position-age SL tightening (20% tighter after 5min for losing positions). Emergency closes are prioritized to prevent liquidation. Cooldowns are implemented for trades, losses, and close attempts.

**DEX Execution Engine:** Integrates with Typus Perps via on-chain Move calls, utilizing a keeper-based system for market orders with gas caps, dry-run preflights, and slippage control.

**Keeper Settlement Timing Protection:** The system includes mechanisms to reconcile PnL based on price during pending keeper settlements, ensuring accurate profit calculation.

**Position Lifecycle State Machine:** Positions transition through `pending_open`, `open`, and `closed` states, with deterministic reconciliation via transaction digest parsing.

**Emergency Close Priority System:** Critical close reasons (e.g., liquidation prevention, max collateral loss) bypass all standard safety barriers like gas caps, cooldowns, and retry limits.

**Transaction Safety & Recovery:** Utilizes per-wallet transaction queues, gas management via CoinManager, safe-execute logic with retries, and dry-run preflights. Comprehensive order cleanup and recovery mechanisms are in place.

**Startup Integrity & Recovery:** At startup, the system cleans up bogus recovery positions and detects untracked on-chain positions, ensuring accurate balance and PnL calculations. Exclusion sets for duplicate detection use ALL positions (including closed) to prevent re-recovery of positions that were already tracked and closed. When a closed DB position is verified still open on-chain, it's re-opened (not duplicated) and given a `reopened_` prefix txDigest so the execution engine manages it with SL/TP. The `recovered_` prefix exclusion was removed from the execution engine so all open positions receive SL/TP management. Content-based dedup matches open positions by (side, entryPrice, sizeSui) to catch duplicates where on-chain position IDs differ from DB records (e.g., adapter returns ID 514 but DB has ID 1152 for the same physical position). When a content match is found, the on-chain position ID is updated to the current adapter-reported value.

**False Liquidation Prevention:** The execution engine's `likelyLiquidated` path (adapter reports position gone) now requires two-factor verification: (1) price-based collateral loss must exceed 80% at current leverage, and (2) an on-chain `LiquidateEvent` must be found matching the position ID. If either check fails, the position is treated as settled/position-gone rather than liquidated. The `positionGoneFromDex` analysis block uses `pos.onChainPositionId` consistently (fixed undefined `positionId` variable bug).

**Activity Endpoint Auto-Recovery:** The activity endpoint now auto-recovers positions that are closed/liquidated in the DB but still open on-chain: it re-opens closed DB records with correct entry price, size, and collateral from on-chain data, or creates new managed positions with `reopened_` prefix txDigest for truly untracked positions with valid entry prices.

**Anti-Liquidation Protection (3-Tier):** Involves stop-loss auto-tightening, a max collateral loss cap (20%), and last-resort emergency closes with dedicated gas budgets. Daily gas caps auto-pause agents to prevent excessive SUI spend.

**Safety Systems:** Include a Position Monitor, Circuit Breaker for consecutive failures, Daily Spend Cap, and Auto-Resume for paused agents. Gas management employs a two-tier policy with dynamic budgeting and reserves.

**Agent Ownership & Rewards:** Agents are tied to user wallets, with on-chain rewards escrowed for profitable position closures and configurable reward shares.

**Portfolio Display & Chain-Derived Stats:** All portfolio values and statistics are computed server-side using Pyth Oracle data, providing a single source of truth. This includes detailed on-chain accounting of deposits, PnL, gas costs, and rewards. A SUI Flow Tracker categorizes on-chain wallet movements. Both the activity endpoint AND the sui-flow endpoint auto-correct agent DB stats (totalPnl, tradeCount, winRate) when chain-derived values drift from the database. The position monitor auto-clears stale `lastExecutionError` for running agents after 2 minutes. False liquidation correction: chain-derived liquidation counts are cross-referenced against DB position close reasons — only positions with `closeReason="liquidated"` count as liquidations; emergency-prevent closes are reclassified as losses. When chain data shows a real `LiquidateEvent` but DB has a different closeReason, the DB is auto-corrected to "liquidated" (chain is authoritative).

**Learning Engine:** Tracks close outcomes and maintains policy weights using EWMA-based reward scoring, employing a UCB bandit algorithm for close action selection across market regimes. Entry pattern feedback tracks win rates per regime+side combination (e.g., TREND+long, RANGE+short) and dynamically penalizes signal scores for combos with <35% win rate. Combos below 20% win rate with 10+ samples are blocked entirely. Consecutive losses trigger escalating cooldowns (45s base × 1.5^n, then 5min × streak after 3), require STRONG signals only after 2+ losses, and reduce position sizing (85%/70%/50% after 1/2/3+ losses). PnL-aware reward scoring penalizes negative PnL outcomes more heavily.

**Triton Signal Engine:** This regime-aware engine generates signals across multiple timeframes, detecting TREND vs. RANGE markets via ADX. It operates in AGGRESSIVE, PRECISION, or AUTO modes, dynamically adjusting parameters based on market conditions. AGGRESSIVE thresholds: weakScore=40, strongScore=52, emaDistMax=1.8%, minRrTrend=0.5, minRrRange=0.8, htfAligned=+22pts, htfOpposing=-14pts, RSI divergence=-10pts, extreme RSI momentum=-10pts, MACD acceleration=+6pts, no MACD turn=-10pts. MACD turn confirmation required for weak signals in all modes. Position sizing scales from 20% (score 40) to 100% (score 75+) in AGGRESSIVE mode.

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