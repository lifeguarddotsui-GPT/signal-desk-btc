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

Agent ownership is linked to user wallets, with on-chain reward escrow and configurable reward shares. A profit retention system allows agents to retain a percentage of profits to grow their trading capital. The On-Chain Portfolio section displays two primary categories: **Invested** (collateral locked in positions + pending orders + unrealized PnL) and **Free SUI** (on-chain wallet balance = gas reserve + profit savings). Portfolio Value = Invested + Free SUI. Retained Savings (profit retention) is shown as a sub-item of Free SUI. All portfolio values and PnL are computed server-side using Pyth Oracle data, ensuring chain-derived accuracy. Wallet realized PnL is computed as `portfolioValue - totalDeposited` (portfolio-based, not from per-trade accumulation) to ensure accuracy.

**Collateral Computation Rule**: All collateral calculations across the codebase use `pos.collateral || (pos.sizeSui / agent.leverage)` to prefer the stored collateral value over the derived value. This is critical because `sizeSui` is the notional position size (e.g., 64 SUI) and `agent.leverage` may differ from the position's actual leverage at open time. The `collateral` field on positions stores the exact collateral locked at open time.

**Post-Close Coin Merge**: After every successful close, the system merges fragmented SUI coins in the agent wallet (5s delay to allow settlement). This prevents balance fragmentation from Typus returning collateral as separate coin objects.

**Periodic Balance Reconciliation**: The position monitor runs a balance reconciliation every 60 seconds for all active agents. It compares the on-chain wallet balance + locked collateral against the DB balance, correcting discrepancies > 0.1 SUI. This catches drift from settlement delays, gas costs, and external transfers.

**Balance Sync for Synthetic Closes**: When a position is closed with `settled_onchain` (no real close TX), the balance sync checks whether the position is actually still on-chain. **If it is still on-chain, the close is ABORTED** — the position reverts to "open" status so it can be retried, preventing permanent collateral loss from DB-closed positions that are still active on Typus. If the position is confirmed gone, the collateral was returned to the wallet and the balance reflects that. The post-close verification block also runs for `settled_onchain` closes to ensure on-chain truth overrides the DB balance. **Reconciliation also verifies on-chain positions**: the balance reconciliation now queries Typus `getPositions` and includes collateral from any on-chain positions not tracked as open in the DB, preventing balance underreporting from zombie positions.

**Runtime Zombie Position Recovery**: The position monitor runs `recoverZombiePositions()` every 5 minutes, querying Typus for on-chain positions not tracked as open in the DB. If a position exists on-chain but is marked "closed" in DB (zombie), it is re-opened so SL/TP management resumes. New on-chain positions with no DB record are auto-created as managed positions. Pending (un-escrowed) rewards for re-opened positions are voided to prevent double-counting. This complements the startup integrity `detectUntrackedPositions()` check with runtime coverage.

**Paused Agent SL/TP**: The position monitor no longer skips paused agents for SL/TP checks (including `CLOSE_PERMANENTLY_BLOCKED`). Mark prices and unrealized PnL are updated every tick, and close attempts still execute if gas is available. Only the `INSUFFICIENT_GAS below minimum executable gas` condition skips SL/TP entirely.

Gas conservation is a critical design principle, with multiple mechanisms to prevent gas depletion and ensure efficient transaction processing, including gas floors, session gas budgets, exponential backoff on failed closes, and low-gas throttling. **Capital Preservation System** (in `server/dex/gas.ts`): `COLLATERAL_GAS_RESERVE_SUI=2.0` (base gas reserve), `GAS_PER_CLOSE_SUI=0.25` (per-position close budget), `MAX_COLLATERAL_UTILIZATION=0.65` (agents cannot lock >65% of total equity as collateral), `MIN_FREE_SUI_FLOOR=2.5` (minimum free SUI that must remain in wallet after any trade), `LOW_BALANCE_REWARD_SKIP_THRESHOLD=3.0` (reward escrow is deferred when free SUI < 3.0, keeping profits in wallet for gas/capital growth), `SURVIVAL_THRESHOLD_SUI=3.0` (agents enter survival mode requiring STRONG signals below this). The Typus adapter enforces the `MIN_FREE_SUI_FLOOR` as a hard safety net, rejecting trades that would leave insufficient free balance. A Gas Cap Safety System enforces an absolute session gas cap (`ABSOLUTE_SESSION_GAS_CAP_SUI=3.0`) and a gas-to-deposit ratio cap (`GAS_TO_DEPOSIT_RATIO_CAP=25%`). When either cap is breached, the agent is auto-paused with `gasCapBreached=true`, `gasCapBreachedAt`, and `gasCapReason` flags set in the DB. The gas cap status is integrated into the Capital Plan (`gasSafety` field with `safe/warning/critical/breached` status). At `>=50%` utilization, position sizing is reduced to 75%; at `>=75%`, sizing drops to 50% and max positions to 1. The gas cap flag is cleared when an agent is resumed via `registerTopoffResume()`.

**Position Re-open Loop Guard**: The on-chain position sync logic prevents infinite close/re-open cycles via `positionReopenCounts` (max 2 re-opens per position) and a 5-minute cooldown for `settled_onchain` positions. This prevents the scenario where positions are closed with synthetic digests, then re-opened because on-chain sync still finds them, creating an infinite loop that spammed close_outcomes and drained gas via RPC calls. The `logCloseOutcome` function also has a dedup guard that prevents creating duplicate synthetic close outcomes for the same position+digest. Settlement polling (30-second wait) is skipped for `settled_onchain` positions since no real TX was submitted. Startup integrity includes `deduplicateSyntheticCloseOutcomes()` to clean up historical duplicates. The activity endpoint (`/api/agents/:id/activity`) no longer re-opens closed DB positions that are still on-chain — instead, they are listed as `untrackedOnChainPositions` for display purposes, preventing position flickering and DB thrashing while still correctly reflecting locked collateral and position counts.

The Learning Engine tracks trade outcomes, maintains per-agent policy weights using EWMA-based reward scoring, and employs a UCB bandit algorithm for close action selection, incorporating competitive scoring and a "survival mode" for low-gas situations. It uses only real production data from on-chain verified trades — no simulations. Close outcomes are deduplicated by `positionDbId` (keeping latest per position) and filtered to exclude synthetic digests (`settled_onchain`, `closed_externally`, `recovered_*`, `sim_*`, etc.) via the shared `filterAndDeduplicateOutcomes()` helper in `learning-engine.ts`. A Capital Plan system computes per-agent recommendations for concurrent positions (1-3 based on win rate), position sizing multipliers, free SUI reserve targets, hedge eligibility, and profit reinvestment rates. Quality Metrics track per-agent latency, slippage, fill rate, gas efficiency, and on-chain verification rate. Regime blocking prevents agents from trading unprofitable regime+side combinations (blocked at <25% win rate with ≥5 samples). Adaptive score thresholds raise the minimum signal score for agents with poor recent performance. The Triton Signal Engine is regime-aware, generating signals across multiple timeframes for TREND vs. RANGE markets, operating in AGGRESSIVE, PRECISION, or AUTO modes.

A Gas Top-Off System provides convenient ways to refill agent wallets. Fast Position Display ensures real-time UI updates, and a Position Close Priority System sorts close operations based on urgency and risk.

**Open Code Tab** (`/open-code`): Displays the project's source code for transparency. Uses a secure API (`/api/code/tree` and `/api/code/file`) that only serves files from allowed directories (`client/src/`, `shared/`, `server/`) and filters out sensitive files (reward-wallet.ts, wallet-manager.ts, coin-manager.ts, .env, private keys, etc.). Content is scanned for sensitive patterns (PRIVATE_KEY, mnemonic, SESSION_SECRET, etc.) before serving. File size capped at 500KB.

**Learning Engine Dashboard Fixes**: The "Success Rate" metric was renamed to "Win Rate" and now correctly shows the percentage of profitable trades (pnl > 0) rather than "successfully closed" trades. The Patterns tab strips agent UUIDs from action keys for cleaner display, and "UNKNOWN" regimes display as "Mixed" or "N/A" instead of raw "UNKNOWN" text.

**Protocol Wallet On-Chain Balance**: The Protocol page now shows the live on-chain SUI balance of the protocol fee wallet via `getOnChainBalance(PROTOCOL_FEE_ADDRESS)`, with a link to SuiScan explorer.

**Reward Claiming**: The Claim Rewards page at `/rewards` allows connected wallets to claim their earned rewards. The flow: sign a personal message → backend verifies wallet ownership → checks the user is the agent creator or depositor → transfers SUI from the reward escrow wallet to the user. On-demand escrow is attempted if funds haven't been moved yet.

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