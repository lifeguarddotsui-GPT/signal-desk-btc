# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform designed for autonomous trading of SUI-USDC perpetual contracts. It features a dual-agent architecture, a Market Dashboard with live Pyth Oracle data and charting, and AI Signal Reasoning. The platform aims to provide a transparent and user-centric experience for deploying, managing, and monitoring AI trading agents with auditable on-chain transactions, contributing to robust, AI-driven perpetual futures trading in the Web3 ecosystem.

## User Preferences
Not specified.

## System Architecture
The platform's frontend is built with React, Vite, Tailwind CSS, and shadcn/ui, integrating with SUI wallets. The backend uses Express.js, PostgreSQL (with Drizzle ORM), and a WebSocket server for real-time data.

**Core Architectural Decisions & Features:**

*   **Dual-Agent System:** Each deployment includes an Execution Agent (wallet, orders, positions, risk management) and a Signal Sub-Agent (indicator analysis, signal generation). The Triton Signal Engine is regime-aware, uses multi-timeframe data, and supports Aggressive, Precision, and Auto modes based on weighted scoring and configurable thresholds. It incorporates short loss cooldowns (30s per loss, 3min for 3+ streaks) and uses adaptive position sizing (25-100% based on signal score).
*   **DEX Execution Engine:** Utilizes a `DexAdapter` for Typus Perps, executing on-chain Move calls with keeper-based market orders, per-position close gas caps, and strict market order enforcement with slippage control.
*   **Position Lifecycle State Machine:** Implements a strict `pending_open` → `open` → `closed` lifecycle with deterministic reconciliation via TX digest parsing. It includes multi-level close recovery, background verification, and robust PnL integrity handling, especially for Typus's two-step `position_id` assignment.
*   **Idempotent Close State Machine:** Features DB-persisted close state tracking to prevent close spam, with retry logic, a watchdog TTL, and terminal error detection (e.g., `order_not_found`). It uses dry-run preflights and pre-close existence checks to optimize gas usage and verify on-chain status.
*   **Transaction Safety & Recovery:** Employs a per-wallet transaction queue, `CoinManager` for gas reserves, `safe-execute` with retry logic, and dry-run preflights. It includes three-layer order cleanup and orphaned order recovery.
*   **Anti-Liquidation Protection:** A three-tier system (stop-loss auto-tightening, max collateral loss cap, emergency close) protects against liquidation. Daily gas caps automatically pause agents.
*   **Monitoring and Control:** A `Position Monitor` checks open positions, a `Circuit Breaker` pauses agents after failed operations, and a `Daily Spend Cap` limits gas spending.
*   **Oracle Integration:** Pyth Network's Hermes API provides primary price data, with validation and stale price guards.
*   **Gas Management:** Features a two-tier gas policy, dynamic budgeting, safety margins, and coin merging capabilities.
*   **Agent Ownership & Rewards:** Agents are tied to the creator's wallet, with on-chain rewards escrowed for profitable position closures. Reward calculations are based on `reinvestedAmount` and balance-confirmed settlements.
*   **Comprehensive Portfolio Display:** The "My Agents" page provides an on-chain-verified breakdown of portfolio value, on-chain wallet balance, positions, pending orders, and PnL. It unifies closed positions using chain-derived trade data merged with DB records. It also supports liquidation classification based on `LiquidateEvent` and detects pending orders. External wallet registration and balance audits are supported.
*   **SUI Flow Tracker:** A dedicated page and API endpoint (`/api/agents/:id/sui-flow`) scans on-chain wallet transaction history, categorizes SUI movements, and identifies liquidations. It uses chain-derived PnL for accuracy.
*   **TX Inspector:** An endpoint (`GET /api/tx/:digest/inspect`) provides detailed information on any Sui transaction digest, used for diagnosing SUI balance changes post-close transactions.
*   **Learning Engine:** Tracks close outcomes in a `close_outcomes` table, maintaining `policy_weights` using EWMA-based reward scoring. It assigns scores based on success, failure, speed, and slippage, updating weights and using a UCB bandit algorithm for action selection.
*   **UI/UX Design:** Features a dark crypto trading theme with a teal primary color, CSS variable-based charting, and mobile-first responsive design.

## External Dependencies
*   **Typus Perps:** On-chain perpetuals trading protocol.
*   **Pyth Oracle:** Real-time market data feed.
*   **PostgreSQL:** Relational database system.
*   **Sui Blockchain:** Underlying decentralized ledger technology.
*   **Vite:** Frontend build tool.
*   **Tailwind CSS:** Utility-first CSS framework.
*   **shadcn/ui:** UI component library.
*   **@mysten/dapp-kit:** SUI wallet integration library.
*   **Express.js:** Backend web application framework.
*   **NaCl:** Used for secure keypair encryption.