# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform focused on autonomous trading of SUI-USDC perpetual contracts on Typus Finance. Its core purpose is to provide users with a transparent and user-centric platform for deploying, managing, and monitoring AI trading agents in decentralized finance. The platform emphasizes auditable on-chain transactions and features a dual-agent architecture, a comprehensive Market Dashboard with live Pyth Oracle data and multi-timeframe charting, and the Triton Signal Engine for regime-aware AI signal generation. The project aims to empower users with advanced AI-driven trading strategies and capitalize on the growing DeFi market.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for dynamic charting. Navigation is handled through a sidebar.

### Core Architectural Decisions & Features
The system employs a dual-agent architecture, separating the **Execution Agent** (trade execution) from the **Signal Sub-Agent** (market analysis and signal generation). A robust **DEX Execution Engine** integrates with Typus Perps using on-chain Move calls, incorporating resilience mechanisms against RPC issues, gas management, and slippage control.

**Position Management** includes comprehensive lifecycle transitions, deterministic reconciliation, and an emergency close priority system. Transaction safety is ensured via per-wallet transaction queues, gas management, dry-run preflights, and recovery mechanisms. Reward-based position verification uses on-chain rewards as proof of closure. **Anti-liquidation protection** features a three-tier system: stop-loss auto-tightening, max collateral loss caps, and emergency closes with dedicated gas budgets.

**Agent ownership** is linked to user wallets with configurable reward shares. A **Reward Model** records profit shares as reward records (`agent_retained` escrow type) without immediately crediting `ownerClaimableBalance`. Instead, the claimable amount is **computed dynamically** from `min(sum of pending reward records, on-chain free balance - locked collateral - gas reserve)`. This ensures rewards only show as claimable when the agent wallet actually has free SUI to back them. A **profit retention system** allows agents to retain a percentage of profits to grow their trading capital. The **On-Chain Portfolio** displays "Invested" (collateral + pending orders + unrealized PnL) and "Free SUI" (wallet balance + profit savings), with all values and PnL computed server-side using Pyth Oracle data. Wallet realized PnL is calculated as `(portfolioValue + claimedRewards) - netDeposited`, accounting for rewards already transferred out of the agent wallet. **PnL tracking** uses price-based PnL for individual position closes, with portfolio-derived auto-correction (`portfolioValue - netDeposited`) during periodic balance reconciliation and startup integrity checks. The leaderboard uses `portfolioValue` (free + locked) + `claimedRewards` for PnL computation, not raw DB balance. An auto-correction system (`computeChainDerivedStats`) reconciles DB `totalPnl` against on-chain transaction history when the activity page is loaded. Collateral computations prioritize stored `pos.collateral` over derived values.

**Post-Close Coin Merge** automatically merges fragmented SUI coins in agent wallets after successful closes to prevent balance fragmentation. **Periodic Balance Reconciliation** (every 60 seconds) corrects discrepancies between on-chain and DB balances for active agents, including checking for and potentially re-opening "zombie positions" (DB-closed but on-chain active) and detecting untracked on-chain positions. **Runtime Zombie Position Recovery** runs every 2 minutes to re-open or auto-create DB entries for on-chain positions not tracked, with cache invalidation and WebSocket broadcast after recovery. **Stale Close Recovery** runs every 90 seconds, detecting positions stuck in `close_requested` or `manual_review` state for >2 minutes, checking on-chain status, and retrying close through the standard close flow (max 3 recovery attempts per position, respects gas caps and active close serialization). Paused agents continue to have SL/TP monitored unless gas is critically low.

**Gas conservation** is a critical design principle. The **Capital Preservation System** in `dex/gas.ts` defines parameters like `COLLATERAL_GAS_RESERVE_SUI`, `GAS_PER_CLOSE_SUI`, `MAX_COLLATERAL_UTILIZATION`, `MIN_FREE_SUI_FLOOR`, `LOW_BALANCE_REWARD_SKIP_THRESHOLD`, and `SURVIVAL_THRESHOLD_SUI`. The **Gas Cap Safety System** uses a graduated throttle approach (`GasThrottleLevel`: normal → conserving → closes_only → emergency_only → paused) before pausing agents: `ABSOLUTE_SESSION_GAS_CAP_SUI=5.0`, `GAS_TO_DEPOSIT_RATIO_CAP=0.50` (50%), `GAS_PER_OPERATION_ESTIMATE=0.012`. Sessions auto-reset every 6 hours. System-paused agents get `pausedBy="system"`, `pausedReason`, `estimatedResumeAt`, and `gasThrottleLevel` fields. Auto-resume logic handles `GAS_BUDGET_EXHAUSTED`/`GAS_CAP_BREACHED` patterns with session reset detection. Position sizing and max position count are dynamically adjusted based on gas utilization. A **Position Re-open Loop Guard** prevents infinite close/re-open cycles through `positionReopenCounts` and cooldowns.

The **Learning Engine** tracks trade outcomes, maintains per-agent policy weights using EWMA-based reward scoring, and employs a UCB bandit algorithm for close action selection, utilizing only real production data. It incorporates competitive scoring and a "survival mode." The **Capital Plan system** is collateral-aware and per-agent, providing recommendations based on `minCollateral`/`maxCollateral`, with capital profiles (micro/small/medium/large) determining position slot allocation. Growth phases adapt recommendations, and drawdown detection reduces sizing when max drawdown exceeds 30%. Consecutive loss/win streaks are tracked. Quality Metrics include latency, slippage, fill rate, gas efficiency, and on-chain verification rate. **Regime blocking** prevents trading unprofitable `regime+side` combinations, and **adaptive score thresholds** adjust minimum signal scores for agents with poor performance. The **Triton Signal Engine** is regime-aware, generating signals across multiple timeframes for TREND vs. RANGE markets in AGGRESSIVE, PRECISION, or AUTO modes.

A **Gas Top-Off System** provides agent wallet refilling. **Fast Position Display** ensures real-time UI updates, and a **Position Close Priority System** sorts close operations by urgency. **Portfolio Value Stabilization** prevents balance flickering during position settlements: the server tracks settling positions (`close_tx_submitted`/`close_order_working` states) and anchors portfolio values during transient inconsistencies (>10% change within 20s while settling). The frontend applies a `useStableValue` hook that only activates during settling periods, requiring 2 consecutive confirmations before accepting large changes. Position cards show live transition states: "Opening... verifying on-chain", "Closing... transaction submitted", and "Awaiting fill... order working". **On-Chain Position Recovery** uses an info-blue theme (not warning-amber) with descriptive messaging: "Found on blockchain — syncing to dashboard". The "Verify & Recover" button includes a disclaimer explaining it scans blockchain for untracked positions and reconciles PnL.

An **Open Code Tab** (`/open-code`) provides transparency by displaying source code from allowed directories, with sensitive files and patterns filtered out. The **Learning Engine Dashboard** displays "Win Rate" (profitable trades) and cleans up display of regimes and action keys. The **Protocol Wallet On-Chain Balance** is displayed live on the Protocol page. **Reward Claiming** allows users to claim escrowed rewards via the `/rewards` page, with wallet verification and direct SUI transfer.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit, and wouter, utilizing TanStack Query v5 for data fetching and WebSockets for real-time updates. The backend uses Express.js and PostgreSQL (Drizzle ORM), featuring API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet/coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic.

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
-   **NaCl:** Keypair encryption (likely for secure storage/communication)
-   **Recharts:** Charting library
-   **wouter:** Frontend routing
-   **TanStack Query v5:** Data fetching and cache management