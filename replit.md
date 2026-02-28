# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform designed for autonomous trading of SUI-USDC perpetual contracts using a dual-agent architecture. It provides a Market Dashboard with live Pyth Oracle data, professional charting, and AI Signal Reasoning. The platform enables users to deploy, manage, and monitor trading agents, claim rewards, and access protocol statistics. A core principle is transparency through verifiable on-chain transactions, ensuring all agent actions are user-initiated and auditable. The project aims to establish a robust, transparent, and user-centric platform for AI-driven perpetual futures trading within the Web3 ecosystem.

## User Preferences
Not specified.

## System Architecture
The platform utilizes a React, Vite, Tailwind CSS, and shadcn/ui frontend, integrated with SUI wallets via `@mysten/dapp-kit`. The backend is built with Express.js, PostgreSQL (managed by Drizzle ORM), and incorporates a WebSocket server for real-time data communication.

**Core Architectural Decisions & Features:**

-   **Dual-Agent System:** Each deployment consists of an Execution Agent (managing wallet, balances, orders, positions, and risk) and an automatically generated Signal Sub-Agent (performing indicator analysis and generating trading signals based on a 4-of-7 condition score with margin requirements).
-   **DEX Execution Engine:** Uses a `DexAdapter` interface for Typus Perps, executing direct on-chain Move calls. Trades require successful on-chain execution, with no simulation fallback. Supports up to 5 concurrent positions per agent with locked collateral tracking and a 30-second cooldown for same-direction trades. **Self-Matching Market Orders:** Typus NEVER fills orders synchronously — ALL orders are created as pending (`filled=false`) and require a keeper to call `match_trading_order`. To achieve instant market execution, after `create_trading_order` the adapter immediately calls `match_trading_order` (package `0xf60e3542...`) with oracle update + LP vault objects to self-match the order. If self-match fails, falls back to keeper polling (15s). If still unfilled, cancels the order to recover collateral. This eliminates dependency on Typus's keeper bot and prevents orphaned orders.
-   **Position Management & PnL Integrity:** Robust handling of Typus's two-step `position_id` assignment process (from `CreateTradingOrderEvent` to `OrderFilledEvent`). Includes mechanisms for close fill verification (scanning both ToAddress and FromAddress TX history, matching `linked_position_id`), ensuring collateral return before confirming closure. No "external close" concept — positions are either on-chain verified, settled on-chain (position gone from DEX with balance reconciliation), or liquidated. Per-position PnL is maintained, and agent-level `totalPnl` is reconciled from on-chain balance. Phantom close prevention and startup integrity checks ensure data consistency. **Collateral Protection:** Post-close balance verification confirms wallet balance actually reflects returned collateral. Balance is NEVER inflated above on-chain truth — when settlement is unconfirmed or RPC fails, conservative estimates are used. Settlement wait is 30s. If a position disappears from DEX with no balance data available, it defaults to liquidation (conservative) rather than settled. **On-Chain Liquidation Detection:** Startup integrity scans wallet TX history for real `LiquidateEvent` events and replaces synthetic close digests with actual on-chain TX hashes.
-   **Transaction Safety & Recovery:** Features a per-wallet transaction queue, `CoinManager` for gas reserves, `safe-execute` with retry logic, and dry-run preflights. Transactions are limited by an allowlist for approved Move call targets and oracle modules. Endpoints for analyzing and importing lost deposit records are available.
-   **Anti-Liquidation Protection:** A three-tier system (stop-loss auto-tightening, hard max collateral loss cap, emergency close) protects against liquidation, designed to mitigate risks as Typus does not support native on-chain SL/TP orders.
-   **Monitoring and Control:** A `Position Monitor` continuously checks open positions against Pyth prices for stop-loss, take-profit, and emergency triggers. A `Circuit Breaker` pauses agents after consecutive failed `OPEN` operations, and a `Daily Spend Cap` pauses agents if gas costs exceed thresholds.
-   **Oracle Integration:** Primary price data is sourced from Pyth Network's Hermes API (SUI/USD), with price validation and stale price guards.
-   **Gas Management:** Employs a two-tier gas policy and dynamic budgeting with a safety margin to prevent transaction failures due to insufficient gas. Supports coin merging.
-   **Agent Ownership & Rewards:** Agents are tied to the creator's wallet, requiring owner authentication for deletion. Rewards are configurable via `rewardSharePct`, and their persistence is ensured even upon agent deletion. Reward creation is contingent on successful on-chain escrow transfer.
-   **Comprehensive Portfolio Display:** The "My Agents" page shows a full on-chain-verified breakdown: Total Portfolio Value (wallet + positions + pending orders + unrealized PnL), On-Chain Wallet balance, In Positions (locked collateral), In Pending Orders (collateral awaiting match), Unrealized PnL, and an Accounting section (net deposited, realized PnL, gas costs, unrecovered collateral). Pending unfilled orders are tracked separately from lost collateral.
-   **UI/UX Design:** Features a dark crypto trading theme with a teal primary color, CSS variable-based charting, and mobile-first responsive design. The "My Agents" page provides a unified fund status, per-position collateral risk bars, and streamlined wallet summaries.

## External Dependencies
-   **Typus Perps:** On-chain perpetuals trading protocol.
-   **Pyth Oracle:** Real-time market data feed.
-   **PostgreSQL:** Relational database system.
-   **Sui Blockchain:** Underlying decentralized ledger technology.
-   **Vite:** Frontend build tool.
-   **Tailwind CSS:** Utility-first CSS framework.
-   **shadcn/ui:** UI component library.
-   **@mysten/dapp-kit:** SUI wallet integration library.
-   **Express.js:** Backend web application framework.
-   **NaCl (Networking and Cryptography library):** Used for secure keypair encryption.