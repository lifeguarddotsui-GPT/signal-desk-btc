# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform enabling autonomous trading of SUI-USDC perpetual contracts on Typus Finance. Its primary goal is to offer a transparent and user-centric environment for deploying, managing, and monitoring AI trading agents in decentralized finance. The platform prioritizes auditable on-chain transactions, features a dual-agent architecture, a comprehensive Market Dashboard with live Pyth Oracle data, and the Triton Signal Engine for regime-aware AI signal generation. The project aims to empower users with advanced AI-driven trading strategies and leverage the expanding DeFi market.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for dynamic charting. Navigation is handled through a sidebar.

### Core Architectural Decisions & Features
The system employs a **dual-agent architecture**, separating the **Execution Agent** (trade execution) from the **Signal Sub-Agent** (market analysis). A **DEX Execution Engine** integrates with Typus Perps using on-chain Move calls, incorporating resilience for RPC issues, gas management, and slippage control.

**Position Management** includes comprehensive lifecycle transitions, deterministic reconciliation, and an emergency close priority system. Transaction safety is ensured via per-wallet transaction queues, gas management, dry-run preflights, and recovery mechanisms. **Anti-liquidation protection** features a multi-tier system: stop-loss auto-tightening, max collateral loss caps (MAX_COLLATERAL_LOSS_PCT=4%, EMERGENCY=6%), emergency closes, **active close verification** — when a protective/emergency close order isn't filled within 10 seconds, the system verifies on-chain, cancels stale orders, and retries immediately — and a **500ms rapid monitor** that detects positions approaching SL/liquidation thresholds and fires immediate close orders, providing sub-second reaction time for high-leverage positions.

**Agent ownership** is linked to user wallets with configurable reward shares. A **Reward Model** dynamically computes claimable rewards based on pending records and the agent wallet's free SUI. A **profit retention system** allows agents to grow their trading capital. The **On-Chain Portfolio** displays "Invested" and "Free SUI," with all values and PnL computed server-side using Pyth Oracle data. PnL tracking uses price-based PnL for individual closes and portfolio-derived auto-correction during periodic balance reconciliation. A **PnL Gain Cap** prevents impossible gain values.

**Post-Close Coin Merge** automatically merges fragmented SUI coins. **Periodic Balance Reconciliation** corrects on-chain/DB discrepancies, including handling "zombie positions." **Runtime Zombie Position Recovery** re-opens or creates DB entries for untracked on-chain positions, with guards against creating duplicates for recently-closed positions (10-minute cooldown). **Stale Close Recovery** retries stuck close operations. **Contradictory State Healing** repairs positions in impossible states.

**Phantom Position Filtering** uses a multi-layered defense combining transaction-level scanning, cross-validation against the DB, and content-match reconciliation to prevent misidentification of closed positions as open and to prevent phantom collateral inflation. Startup integrity detects and removes phantom `reopened_*` positions where the referenced on-chain ID is already tracked by a properly-closed DB position. **Periodic Portfolio Audit** proactively refreshes the on-chain portfolio cache.

**Position Lifecycle Tracking** ensures all closed positions display in the UI regardless of chain-derived matching coverage. The closed positions merge logic only hides DB positions matched to cancelled chain trades when the DB itself marks them as `cancelled_unfilled`. Chain-derived trade matching uses closest-timestamp + collateral-proximity matching for rapid-fire trades. **PnL Transition Stabilization** includes settling collateral in portfolio value during open/close transitions and shows a "settling" indicator.

**Gas conservation** is critical, with a **Capital Preservation System** defining parameters for gas reserves and utilization. A **Gas Cap Safety System** uses a graduated throttle approach before pausing agents, with gas tracked per-attempt and actual on-chain costs asynchronously reconciled.

The **Learning Engine** tracks trade outcomes, maintains per-agent policy weights using EWMA-based reward scoring, and employs a UCB bandit algorithm for close action selection. The **Capital Plan system** is collateral-aware and per-agent, providing recommendations and adapting to growth phases and drawdowns. **Regime blocking** prevents trading unprofitable combinations, and **adaptive score thresholds** adjust signal scores. The **Triton Signal Engine** is regime-aware, generating signals across multiple timeframes.

A **Gas Top-Off System** provides agent wallet refilling. **Fast Position Display** ensures real-time UI updates, and a **Position Close Priority System** sorts close operations. **Portfolio Value Stabilization** prevents balance flickering during position settlements. **On-Chain Position Recovery** provides descriptive messaging for syncing found positions.

An **Open Code Tab** provides transparency by displaying filtered source code. The **Learning Engine Dashboard** displays "Win Rate." The **Protocol Wallet On-Chain Balance** is displayed live. **Reward Claiming** allows users to claim escrowed rewards.

The **SUI Flow Tracker** reconstructs on-chain transaction history for accounting transparency, classifying transactions and incorporating safeguards to prevent data distortion. The SUI Flow page includes an **Accounting Breakdown** waterfall showing Starting Deposits → Trading Gains → Trading Losses → Liquidation Losses → Gas Costs → Rewards → DEX Fees → Current Balance. Open orders are labeled clearly with collateral badges, and liquidation events show a red "Liquidation" badge. A **Rewards Section** displays pending/claimable/claimed rewards. **Keeper Close Detection** scans recent wallet transactions when a position disappears from the DEX, looking for ClosePositionEvent/RemovePositionEvent/DecreasePositionEvent/OrderFilledEvent matching the position ID. When found, it extracts the actual SUI balance change from the transaction to compute real PnL (`returned - collateral`) instead of using potentially stale price-based estimates. This prevents PnL inflation for positions closed by the Typus keeper. DEX Costs are shown as a separate line item when the accounting equation `netDeposited + realizedPnl + unrealizedPnl - gas - rewards = portfolioValue` has an unexplained gap.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit, and wouter, utilizing TanStack Query v5 for data fetching and WebSockets. The backend uses Express.js and PostgreSQL (Drizzle ORM), featuring API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet/coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic.

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