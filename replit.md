# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform designed for autonomous trading of SUI-USDC perpetual contracts on Typus Finance. The platform aims to provide a transparent and user-centric environment for deploying, managing, and monitoring AI trading agents in decentralized finance. Key capabilities include auditable on-chain transactions, a dual-agent architecture, a Market Dashboard powered by live Pyth Oracle data, and the Triton Signal Engine for regime-aware AI signal generation. The project's ambition is to empower users with advanced AI-driven trading strategies and capitalize on the expanding DeFi market.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for dynamic charting. Navigation is sidebar-based.

### Core Architectural Decisions & Features
The system employs a **dual-agent architecture**, comprising an **Execution Agent** for trade execution and a **Signal Sub-Agent** for market analysis. A **DEX Execution Engine** integrates with Typus Perps via on-chain Move calls, incorporating resilience for RPC issues, gas management, and slippage control.

**Position Management** includes comprehensive lifecycle transitions, deterministic reconciliation, and an emergency close priority system. A **Write-Ahead Log (WAL)** pattern is used for database position records. Transaction safety is ensured through per-wallet transaction queues, gas management, dry-run preflights, and recovery mechanisms. **Anti-liquidation protection** features a multi-tier system including stop-loss auto-tightening, max collateral loss caps, and active close verification.

A **Dual-Position Architecture** allows each agent to hold up to two simultaneous positions. Agent ownership is linked to user wallets with configurable reward shares and a dynamic **Reward Model**. The **Dual-Wallet Architecture** assigns each agent a **Funding Wallet** and a **Savings Wallet**. Profits are split between reward escrow, savings, and funding wallets. The **On-Chain Portfolio** displays "Invested," "Funding Wallet," and "Savings Wallet," with PnL computed server-side using Pyth Oracle data.

**EV Formula**: My Wallet Economic Value = Σ(Agent Funding Wallets) + Σ(Agent Savings Wallets) + Σ(Open Position Values) + Capital In Transit + Claimable Rewards. Per-agent Portfolio value = Funding + Savings + Positions (no rewards — rewards are escrowed near-instantaneously to the reward wallet after each trade close). Rewards are included in user's total EV but shown as a separate "Rewards" bucket in the WalletSummaryPanel.

**Recovery and Reconciliation**: Features include **Post-Close Coin Merge**, **Periodic Balance Reconciliation**, **Runtime Zombie Position Recovery**, **Stale Close Recovery**, and **Contradictory State Healing**. An **On-Chain PnL Audit System** verifies closed position PnL. The **Reconciliation Architecture** uses a backend-first canonical portfolio state machine.

**Dynamic SL/TP System**: Each agent operates on a personalized exit strategy range (SL: 25–50bps, TP: 50–100bps) computed by the Capital Plan, adapting to win rate, streaks, and gas pressure. Positions are closed early based on market conditions. **Effective SL Transparency** ensures users are aware of collateral loss caps. **Phantom Position Filtering** prevents misidentification of closed positions.

**Gas conservation** is critical, with a **Capital Preservation System** and a **Gas Cap Safety System** using a graduated throttle.

The **Learning Engine** tracks trade outcomes, maintains per-agent policy weights, and uses a UCB bandit algorithm. The **Capital Plan system** is collateral-aware and adapts to growth/drawdowns. **Regime blocking** and **adaptive score thresholds** prevent unprofitable trading. The **Triton Signal Engine** is regime-aware, generating signals across multiple timeframes, with a clean 5-component composite score (EMA alignment, RSI quality, MACD momentum, Volume, HTF alignment).

**SentimentFlow Engine** (`server/sentiment-flow-engine.ts`) — secondary crowd intelligence layer polling every 60s from two venues: (1) **Hyperliquid REST API** (FlowX Perp is powered by Hyperliquid) — fetches OI, hourly funding rate, order book depth L/S, and recent trade tape for SUI-USD perp (public API, no auth, confirmed accessible from Replit); (2) Typus Perps on-chain `CreateTradingOrderEvent` tape flow — secondary on-SUI tape blended at 30% weight. Derives `tapeScore` (−100 to +100), `crowdingScore` (0−100), `fundingPressureScore`, `oiExpansionScore`, and classifies a `regime` (momentum_continuation / exhaustion / contrarian_squeeze / neutral). Applies a ±8pt modifier to the Triton signal final score via `computeSentimentAdjustment()` in signal-engine.ts. Data persisted to `market_sentiment_snapshots` table every 5 minutes. Exposed via `/api/market/sentiment` and visualized in the SentimentFlow panel on the Market Dashboard. Designed for graceful degradation — returns neutral context when data is unavailable rather than blocking trading. API: `POST https://api.hyperliquid.xyz/info` with `{"type":"metaAndAssetCtxs"}` (SUI is index 14).

**BTC Correlation Overlay Engine** (`server/btc-overlay-engine.ts`) — tertiary leading-indicator layer using BTC multi-timeframe momentum as a predictor for SUI direction (BTC-SUI correlation). Polls Pyth Hermes BTC/USD feed every 60s, maintains a 75-point in-memory circular buffer, and computes momentum across 5m/15m/1h windows. Classifies `bias` (bull/bear/neutral), `strength` (0-100), and `agreementScore` (% of timeframes confirming bias). Applies a ±10pt modifier to the Triton signal via `computeBtcOverlayAdjustment()` in signal-engine.ts. BTC price history persisted to `btc_overlay_snapshots` table every 5 minutes. Exposed via `/api/market/btc-overlay`. Requires 6+ samples to be `usable` (warming up period of ~6 minutes). Visualized as `BtcOverlayPanel` on the Market Dashboard with sparkline, 3-TF direction grid, strength/agreement meters, and signal modifier range display. Graceful degradation — neutral (0pt) when warming up or data stale.

**Critical Safety Hardening**: Includes per-agent and portfolio-level EV circuit breakers, a win rate hard gate, adaptive score bonus, and tightened consecutive-loss gate. Enhancements address phantom position storm prevention, liquidation price guard fixes, and cascade recovery. **PnL Forensic Repair** corrects accounting inconsistencies.

**Precision Adjustments**: A per-agent auto-tuning system where the learning engine periodically fine-tunes `stopLossBps`, `takeProfitBps`, `minCollateral`, `maxCollateral`, and `leverage` based on trade performance. Requires 5+ real trades and respects a 30-minute cooldown. Togglable per-agent (default: on). All changes logged in `precision_adjustment_logs` table with reason and performance stats. Visible in the My Agents card and Edit Agent dialog.

**Idempotent Close State Machine** and **Close Loop Fixes** address issues with Typus API interactions, preventing retry storms and ensuring reliable order cancellation and position settlement.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit, and wouter, utilizing TanStack Query v5 for data fetching and WebSockets. The backend uses Express.js and PostgreSQL (Drizzle ORM), featuring API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet/coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic. A **Performance Tracker** logs portfolio data, and a **SUI Flow Tracker** reconstructs on-chain transaction history.

## External Dependencies
-   **Typus Perps:** On-chain perpetuals trading protocol on SUI
-   **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
-   **PostgreSQL:** Relational database
-   **Sui Blockchain:** SUI mainnet