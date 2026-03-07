# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform designed for autonomous trading of SUI-USDC perpetual contracts on Typus Finance. It aims to empower users with advanced AI-driven trading strategies in decentralized finance by providing a transparent and user-centric experience for deploying, managing, and monitoring AI trading agents with auditable on-chain transactions. Key features include a dual-agent architecture, a Market Dashboard with live Pyth Oracle data and multi-timeframe charting, and the Triton Signal Engine for regime-aware AI signal generation.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform uses a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for charting. Navigation is handled via a sidebar.

### Core Architectural Decisions & Features
The system employs a dual-agent architecture, separating trade execution (Execution Agent) from market analysis and signal generation (Signal Sub-Agent). A robust DEX Execution Engine integrates with Typus Perps using on-chain Move calls, incorporating resilience against RPC issues, gas management, and slippage control.

Position management is comprehensive, covering lifecycle transitions, deterministic reconciliation, and an emergency close priority system. Transaction safety is ensured through per-wallet transaction queues, gas management, dry-run preflights, and recovery mechanisms. Reward-based position verification uses on-chain rewards as proof of closure, preventing "zombie positions." Anti-liquidation protection includes a three-tier system of stop-loss auto-tightening, max collateral loss caps, and emergency closes with dedicated gas budgets.

Agent ownership is linked to user wallets, with on-chain reward escrow and configurable reward shares. A profit retention system allows agents to retain a percentage of profits to grow their trading capital. The platform displays "Free SUI" consistently across the UI, representing the agent's available on-chain balance. All portfolio values and PnL are computed server-side using Pyth Oracle data, ensuring chain-derived accuracy. Wallet realized PnL is computed as `portfolioValue - totalDeposited` (portfolio-based, not from per-trade accumulation) to ensure accuracy.

Gas conservation is a critical design principle, with multiple mechanisms to prevent gas depletion and ensure efficient transaction processing, including gas floors, session gas budgets, exponential backoff on failed closes, and low-gas throttling.

The Learning Engine tracks trade outcomes, maintains per-agent policy weights using EWMA-based reward scoring, and employs a UCB bandit algorithm for close action selection, incorporating competitive scoring and a "survival mode" for low-gas situations. It uses only real production data from on-chain verified trades — no simulations. Close outcomes are deduplicated by `positionDbId` (keeping latest per position) and filtered to exclude synthetic digests (`settled_onchain`, `closed_externally`, `recovered_*`, `sim_*`, etc.) via the shared `filterAndDeduplicateOutcomes()` helper in `learning-engine.ts`. A Capital Plan system computes per-agent recommendations for concurrent positions (1-3 based on win rate), position sizing multipliers, free SUI reserve targets, hedge eligibility, and profit reinvestment rates. Quality Metrics track per-agent latency, slippage, fill rate, gas efficiency, and on-chain verification rate. Regime blocking prevents agents from trading unprofitable regime+side combinations (blocked at <25% win rate with ≥5 samples). Adaptive score thresholds raise the minimum signal score for agents with poor recent performance. The Triton Signal Engine is regime-aware, generating signals across multiple timeframes for TREND vs. RANGE markets, operating in AGGRESSIVE, PRECISION, or AUTO modes.

A Gas Top-Off System provides convenient ways to refill agent wallets. Fast Position Display ensures real-time UI updates, and a Position Close Priority System sorts close operations based on urgency and risk.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit, and wouter. Data fetching uses TanStack Query v5, with WebSockets for real-time updates. The backend uses Express.js and PostgreSQL (Drizzle ORM), with a WebSocket server. It includes API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet/coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic.

## External Dependencies
-   **Typus Perps:** On-chain perpetuals trading protocol on SUI
-   **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
-   **PostgreSQL:** Relational database
-   **Sui Blockchain:** SUI mainnet
-   **Vite:** Frontend build tool
-   **Tailwind CSS:** Utility-first CSS framework
-   **shadcn/ui:** UI component library
-   **@mysten/dapp-kit:** SUI wallet integration
-   **@mysten/sui:** SUI SDK
-   **Express.js:** Backend framework
-   **NaCl:** Keypair encryption
-   **Recharts:** Charting library
-   **wouter:** Frontend routing
-   **TanStack Query v5:** Data fetching and cache management