# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform for autonomous trading of SUI-USDC perpetual contracts using a dual-agent architecture. It offers a Market Dashboard with live Pyth Oracle data, charting, and AI Signal Reasoning. The platform focuses on transparency and user control, enabling deployment, management, and monitoring of AI trading agents with auditable on-chain transactions. The project's vision is to provide a robust, transparent, and user-centric platform for AI-driven perpetual futures trading within the Web3 ecosystem.

## User Preferences
Not specified.

## System Architecture
The platform utilizes a React, Vite, Tailwind CSS, and shadcn/ui frontend, integrated with SUI wallets. The backend is built with Express.js, PostgreSQL (managed by Drizzle ORM), and incorporates a WebSocket server for real-time data communication.

**Core Architectural Decisions & Features:**

*   **Dual-Agent System:** Each deployment includes an Execution Agent (managing wallet, orders, positions, and risk) and a Signal Sub-Agent (performing indicator analysis and generating trading signals).
*   **DEX Execution Engine:** Uses a `DexAdapter` interface for Typus Perps, executing direct on-chain Move calls. Includes keeper-based market orders, per-position close gas caps, and strict market order enforcement with slippage. **Market Close Builder:** Close orders use zero collateral (reduce-only), correct close direction (`closeIsLong = !positionIsLong`), `isStopOrder=false`, and dedicated `marketCloseTriggerPrice()` with `CLOSE_SLIPPAGE_BPS=500` (5%) for immediate fills. Closing a LONG sets trigger BELOW market (sell); closing a SHORT sets trigger ABOVE market (buy).
*   **Position Management & PnL Integrity:** Robust handling of Typus's two-step `position_id` assignment with `typusOrderId` stored at open time for reliable close resolution. Open flow re-fetches TX receipt via `waitForTransaction` + `getTransactionBlock` for deterministic event capture. Close flow uses stored order_id → wallet TX history → open TX receipt → global event scan as resolution cascade. All force-settle paths require on-chain balance confirmation before marking positions closed. Features close fill verification, collateral protection, price guard protection, and on-chain liquidation detection with PnL recalculation and startup integrity checks.
*   **Idempotent Close State Machine:** DB-persisted close state tracking per position (`closeState`, `closeAttempts`, `lastCloseTx`, `closePendingSince`). States: `open` → `close_requested` → `close_tx_submitted` → `close_order_working` → `closed` / `manual_review`. Prevents close spam by refusing to resubmit while a close is pending on Typus (120s TTL). Hard stop after 5 total close attempts (persisted, not resettable by recovery). Minimum 15s gap between close retries. Blocked recovery respects DB attempt limits and won't reset gas tracking indefinitely.
*   **Transaction Safety & Recovery:** Implements a per-wallet transaction queue, `CoinManager` for gas reserves, `safe-execute` with retry logic, and dry-run preflights. Includes orphaned order recovery and pre-close cleanup mechanisms.
*   **Anti-Liquidation Protection:** A three-tier system (stop-loss auto-tightening, max collateral loss cap, emergency close) protects against liquidation. Features per-position close gas caps, pre-close existence checks, unresolved position guards, and strict RPC balance policies. Daily gas caps auto-pause agents.
*   **Monitoring and Control:** A `Position Monitor` continuously checks open positions. A `Circuit Breaker` pauses agents after consecutive failed operations, and a `Daily Spend Cap` pauses agents if gas costs exceed thresholds. Includes mechanisms for handling "phantom linked orders" and persistent gas cap tracking.
*   **Oracle Integration:** Primary price data is sourced from Pyth Network's Hermes API (SUI/USD), with price validation and stale price guards.
*   **Gas Management:** Employs a two-tier gas policy and dynamic budgeting with a safety margin. Supports coin merging.
*   **Agent Ownership & Rewards:** Agents are tied to the creator's wallet, with configurable rewards escrowed on-chain upon profitable position closure. Includes force-settle recovery mechanisms using hybrid event query and wallet TX history approaches.
*   **Comprehensive Portfolio Display:** The "My Agents" page provides on-chain-verified breakdown of Total Portfolio Value, On-Chain Wallet balance, In Positions, In Pending Orders, Unrealized PnL, and an Accounting section. Includes unrecovered SUI detail display.
*   **SUI Flow Tracker:** A dedicated page and API endpoint (`/api/agents/:id/sui-flow`) scans on-chain wallet transaction history, categorizes SUI movements, and identifies likely liquidations with detailed explanations.
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
*   **NaCl (Networking and Cryptography library):** Used for secure keypair encryption.