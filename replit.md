# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform designed for autonomous trading of SUI-USDC perpetual contracts on Typus Finance. The platform provides a transparent and user-centric environment for deploying, managing, and monitoring AI trading agents in decentralized finance. Key capabilities include auditable on-chain transactions, a dual-agent architecture, a Market Dashboard powered by live Pyth Oracle data, and the Triton Signal Engine for regime-aware AI signal generation. The project aims to empower users with advanced AI-driven trading strategies and capitalize on the expanding DeFi market.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for dynamic charting. Navigation is sidebar-based.

### Core Architectural Decisions & Features
The system employs a **dual-agent architecture** with an **Execution Agent** for trade execution and a **Signal Sub-Agent** for market analysis. A **DEX Execution Engine** integrates with Typus Perps via on-chain Move calls, incorporating resilience for RPC issues, gas management, and slippage control.

**Position Management** includes comprehensive lifecycle transitions, deterministic reconciliation, an emergency close priority system, and a Write-Ahead Log (WAL) pattern for database records. Transaction safety is ensured through per-wallet transaction queues, gas management, dry-run preflights, and recovery mechanisms. **Anti-liquidation protection** features a multi-tier system including stop-loss auto-tightening and max collateral loss caps.

A **Dual-Position Architecture** allows each agent to hold up to two simultaneous positions. Agent ownership is linked to user wallets with configurable reward shares and a dynamic **Reward Model**. The **Dual-Wallet Architecture** assigns each agent a **Funding Wallet** and a **Savings Wallet**, with profits split among reward escrow, savings, and funding wallets. The **On-Chain Portfolio** displays "Invested," "Funding Wallet," and "Savings Wallet," with server-side PnL computation using Pyth Oracle data.

**Recovery and Reconciliation** features include post-close coin merging, periodic balance reconciliation, runtime zombie position recovery, stale close recovery, and contradictory state healing. An **On-Chain PnL Audit System** verifies closed position PnL, using a backend-first canonical portfolio state machine.

A **Dynamic SL/TP System** allows agents to operate on personalized exit strategy ranges, adapting to win rate, streaks, and gas pressure. Positions are closed early based on market conditions, with **Effective SL Transparency** for users.

**Gas conservation** is managed by a **Capital Preservation System** and a **Gas Cap Safety System** with a graduated throttle.

The **Learning Engine** tracks trade outcomes and maintains per-agent policy weights using a UCB bandit algorithm. The **Capital Plan system** is collateral-aware and adapts to growth/drawdowns. **Regime blocking** and **adaptive score thresholds** prevent unprofitable trading. The **Triton Signal Engine** is regime-aware, generating signals across multiple timeframes with a 5-component composite score.

An **Intelligence Layer** provides advanced AI capabilities:
-   **Feature Store** centralizes market feature assembly for model inputs.
-   **Win Probability Model** scores pre-trade setups, calibrated and stored in `probability_predictions`.
-   **Probability Calibration System** freezes win probability snapshots at trade entry and continuously calibrates performance across buckets.
-   **Risk Management Agent** acts as a pre-trade gate, checking probability, drawdown, and risk factors to potentially block trades or adjust size/leverage.
-   **Risk-Adjusted Reward Engine** replaces flat PnL labels with a multi-component score for policy weight updates.
-   **Continuous Evaluator** assesses agent performance (win rates, calibration, regime fit) every 10 minutes, providing status updates.
-   **Analysis Agent** polls news for sentiment scoring, feeding modifiers into Triton signals.
-   **Win Probability Badge** and **Model Calibration Chart** visualize model predictions and calibration accuracy on the UI.
-   **Market Intelligence Page** displays sentiment, continuous evaluation, and model calibration.

The **CHOP_SCALP Regime** is a dedicated market regime for sideways markets, switching from trend-following to range mean-reversion with specific range detection and scoring mechanisms.

The **SentimentFlow Engine** is a secondary crowd intelligence layer, polling data from Hyperliquid and Typus Perps on-chain events to derive `tapeScore`, `crowdingScore`, `fundingPressureScore`, and `oiExpansionScore`, applying a modifier to the Triton signal.

The **BTC Correlation Overlay Engine** is a tertiary leading-indicator layer using BTC multi-timeframe momentum to predict SUI direction, applying a modifier to the Triton signal.

**Critical Safety Hardening** includes per-agent and portfolio-level EV circuit breakers, win rate hard gates, and adaptive score bonuses. **PnL Forensic Repair** corrects accounting inconsistencies.

**Precision Adjustments** is an auto-tuning system where the learning engine fine-tunes agent parameters (`stopLossBps`, `takeProfitBps`, `minCollateral`, `maxCollateral`, `leverage`) based on performance.

An **Idempotent Close State Machine** and **Close Loop Fixes** ensure reliable order cancellation and position settlement with the Typus API.

The **Liquidity Trap Engine** detects stop-hunt fake breakouts and generates priority trade signals.

The **Micro Scalp Anti-Idle Engine** activates for idle agents in tradable markets, building micro support/resistance and executing tight-parameter trades.

A **Dynamic Threshold System** centralizes all entry threshold adjustments, replacing inline logic.

The **Market Tradability Score** computes a 0-100 score based on candle depth, oracle freshness, and regime quality, gating the micro-scalp anti-idle engine.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit, and wouter, utilizing TanStack Query v5 for data fetching and WebSockets. The backend uses Express.js and PostgreSQL (Drizzle ORM), featuring API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet/coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic. A **Performance Tracker** logs portfolio data, and a **SUI Flow Tracker** reconstructs on-chain transaction history.

## External Dependencies
-   **Typus Perps:** On-chain perpetuals trading protocol on SUI
-   **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
-   **PostgreSQL:** Relational database
-   **Sui Blockchain:** SUI mainnet
-   **Hyperliquid REST API:** For market sentiment data