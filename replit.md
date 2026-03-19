# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform designed for autonomous trading of SUI-USDC perpetual contracts on Typus Finance. Its primary goal is to offer a transparent and user-centric environment for deploying, managing, and monitoring AI trading agents in decentralized finance. Key features include auditable on-chain transactions, a dual-agent architecture, a comprehensive Market Dashboard powered by live Pyth Oracle data, and the Triton Signal Engine for regime-aware AI signal generation. The project aims to empower users with advanced AI-driven trading strategies and leverage the expanding DeFi market.

## User Preferences
Not specified.

## System Architecture

### UI/UX
The platform features a mobile-first, responsive dark theme with teal as the primary color, utilizing CSS variables for dynamic charting. Navigation is sidebar-based.

### Core Architectural Decisions & Features
The system utilizes a **dual-agent architecture**, distinguishing between the **Execution Agent** (trade execution) and the **Signal Sub-Agent** (market analysis). A **DEX Execution Engine** integrates with Typus Perps via on-chain Move calls, incorporating resilience for RPC issues, gas management, and slippage control.

**Position Management** includes comprehensive lifecycle transitions, deterministic reconciliation, and an emergency close priority system. A **Write-Ahead Log (WAL)** pattern creates DB position records before on-chain transaction submission. Transaction safety is ensured via per-wallet transaction queues, gas management, dry-run preflights, and recovery mechanisms. **Anti-liquidation protection** features a multi-tier system including stop-loss auto-tightening, max collateral loss caps, active close verification, and a rapid monitor for approaching thresholds.

A **Dual-Position Architecture** allows each agent to hold up to two simultaneous positions for hedging or doubling-down, with smart gating for second position opening. Agent ownership is linked to user wallets with configurable reward shares and a dynamic **Reward Model**.

The **Dual-Wallet Architecture** assigns each agent a **Funding Wallet** for trades and gas, and a **Savings Wallet** for accumulating a portion of trading profits. Profits are split between reward escrow, savings wallet, and funding wallet. The **On-Chain Portfolio** displays "Invested," "Funding Wallet," and "Savings Wallet," with PnL computed server-side using Pyth Oracle data. PnL tracking includes a **PnL Gain Cap** and **PnL Transition Stabilization**.

**Post-Close Coin Merge** automatically merges fragmented SUI coins. **Periodic Balance Reconciliation** corrects discrepancies. **Runtime Zombie Position Recovery** re-opens DB entries for untracked on-chain positions. **Stale Close Recovery** retries stuck close operations. **Contradictory State Healing** repairs impossible position states.

An **On-Chain PnL Audit System** runs in the background, verifying closed position PnL against actual on-chain transaction data.

**Reconciliation Architecture** uses a backend-first canonical portfolio state machine that runs periodically, computing a full decomposed portfolio snapshot.

**Dynamic SL/TP System**: Each agent operates on a personalized exit strategy range (SL: 25–50bps, TP: 50–100bps) computed by the Capital Plan based on win rate, consecutive streaks, and gas pressure. Agents close positions *early* when market conditions confirm: profit decay, opposing signal strength, position age, or high-aggression mode.

**Effective SL Transparency** ensures users are aware of how maximum collateral loss caps impact effective stop-loss at high leverage. **Phantom Position Filtering** uses multi-layered defenses to prevent misidentification of closed positions and collateral inflation. **Position Lifecycle Tracking** ensures all closed positions display in the UI. **PnL Gap Reconciliation** distributes PnL discrepancies. **Liquidation Detection** corrects PnL for liquidated positions. A "Close All Positions" endpoint allows bulk closing.

**Gas conservation** is critical, with a **Capital Preservation System** and a **Gas Cap Safety System** using a graduated throttle. Gas tracking charges only for operations submitting actual on-chain transactions.

The **Learning Engine** tracks trade outcomes, maintains per-agent policy weights, and employs a UCB bandit algorithm for close action selection. The **Capital Plan system** is collateral-aware and adapts to growth/drawdowns. **Regime blocking** and **adaptive score thresholds** prevent unprofitable trading. The **Triton Signal Engine** is regime-aware, generating signals across multiple timeframes.

A **Gas Top-Off System** provides agent wallet refilling. **Fast Position Display** ensures real-time UI updates, and a **Position Close Priority System** sorts close operations. **Portfolio Value Stabilization** prevents balance flickering. **On-Chain Position Recovery** provides descriptive messaging, and **Automatic Position Recovery** auto-reopens force-settled closed DB positions that are still open on-chain. **Cancelled Position PnL Correction** ensures `cancelled_unfilled` positions have 0 PnL.

An **Open Code Tab** provides transparency. The **Learning Engine Dashboard** displays "Win Rate." The **Protocol Wallet On-Chain Balance** is displayed live. **Reward Claiming** allows users to claim escrowed rewards. An **About Blue Water AI** page provides educational content.

The **SUI Flow Tracker** reconstructs on-chain transaction history for accounting transparency. The SUI Flow page includes an **Accounting Breakdown** waterfall. **Keeper Close Detection** scans recent wallet transactions to extract actual SUI balance changes for real PnL computation for positions closed by the Typus keeper.

**Signal Engine Quality Improvements**: Enhancements to `htfBias()`, `combinedHTFBias()`, `htfNeutralPoints`, `minRrTrend`, `volMin`, and added a TRANSITION regime uncertainty penalty and execution gate. `findTradeSide` now uses 5m price vs EMA20 as direction tiebreaker in TRANSITION+NEUTRAL HTF.

**Critical Safety Hardening**: Implemented per-agent and portfolio-level EV circuit breakers, a win rate hard gate, adaptive score bonus for all modes, hard block for HTF conflicts, and tightened consecutive-loss gate.

**Post-Cascade Safety Hardening**: Fixed a consecutive loss tracking bug, introduced a 30-minute liquidation hard block, fully blocked TRANSITION regime entries, disallows entries when HTF is NEUTRAL, reduced leverage hard cap, and increased `BASE_LOSS_COOLDOWN_MS`. Also introduced a portfolio-level correlated direction block.

**Settlement Fix — Phantom Position Storm Prevention**: Fixed an infinite recovery loop in `recoverUntrackedPositions` where positions closed with synthetic digests (e.g., `position_gone_onchain`) were being reopened every 60s because the Typus keeper fill was still pending. This caused 30+ phantom DB records, each with `closedAt < 300s`, inflating `settlementPending` to 505+ SUI and `economicValue`/`totalPnl` to nonsensical values. Fix: (1) REOPEN_COOLDOWN extended from 60s to 600s; (2) added dedup guard preventing new record creation for on-chain positions closed within 10 min; (3) `settledPendingFromClosed` now only counts positions with real on-chain TX digests (≥40 chars, not synthetic). **Liquidation Price Guard Fix**: The close-detection price guard incorrectly classified liquidated positions as "settled" when price recovered from the liquidation peak. Fix: also check whether the 24h high/low ever breached `pos.liquidationPrice` to correctly identify liquidations where price has since reversed.

**T3 Cascade Recovery**: T3 frequency recalibration caused a race condition (activeExecutions.add() was called 200+ lines after the has() check, allowing 4+ simultaneous positions) and used statistically-unproven TRANSITION regime unblock (20-sample EV insufficient). This caused 17 consecutive losses for Diogenes (-40 SUI) and 11 for Oceanus (-20 SUI). Fixes applied: (1) **Race condition fixed** — lock now acquired immediately after has() check; all 15+ early-exit paths explicitly release the lock. (2) **Signal thresholds reverted to pre-T3 safe values** — AGGRESSIVE weakScore 55/strongScore 65/adxTrendMin 18/volMin 0.50/minRrTrend 1.80; AUTO weakScore 52/strongScore 62/adxTrendMin 20/volMin 0.45/minRrTrend 1.60; PRECISION weakScore 62/strongScore 72/adxTrendMin 22/volMin 0.70. (3) **TRANSITION regime re-hard-blocked** for all modes until ≥200-trade sample confirms positive EV. Mode-aware cooldowns retained: AGGRESSIVE post-close 20s/trade 45s. Win rate gate floor 72/threshold 28% retained.

**PnL Forensic Repair**: Corrected a critical accounting inconsistency where "Realized Losses" were overcounting losses by adjusting `agent.totalPnl` using canonical snapshot derivation and regular reconciliation. A new forensics endpoint provides detailed PnL audit, and the WalletSummaryPanel displays an expandable "PnL Breakdown".

**Close Loop Fix & Position Dedup**: Fixed two critical bugs. (1) **Position duplication**: `recoverUntrackedPositions` content match only checked `status === "open"`, causing phantom 3rd DB records for `pending_open` positions whose on-chain ID wasn't yet resolved — showed 3 positions when only 2 were deployed. Fixed by including `pending_open` in content match. (2) **cancel_trading_order spam loop**: `CLOSE_PENDING_TTL_MS` was 30s — too short for Typus keeper fills — so the system cancelled and resubmitted close orders every 30s indefinitely. Fixed by raising TTL to 90s, adding a 60s cancel dedup window per position, adding on-chain verification before cancel+resubmit on TTL expiry, and removing the premature 20s `DbPendingScan` state reset. The system now waits for the keeper to fill the close order before cancelling.

**Signal Engine Redesign (T4)**: Complete rewrite of `server/signal-engine.ts` with a clean 5-component composite score (0–100): EMA alignment 0–25, RSI quality 0–20, MACD momentum 0–25, Volume 0–15, HTF alignment 0–15. Mode thresholds simplified to `{threshold, label, description}` — NOW=30, AGGRESSIVE=48, AUTO=55, PRECISION=70. Side selection uses HTF + MACD direction + price vs EMA20. Penalties: TRANSITION regime −5. `ScoreBreakdown` interface exposed in API and UI. Execution gates simplified: TRANSITION hard block removed (score penalizes it), HTF NEUTRAL hard block removed (score penalizes it), NOW mode skips learning engine hard blocks and consecutive loss gate. Counter-trend hard block kept for all modes. UI redesigned with per-indicator progress bars in both agent Signal tab and Market Dashboard.

### Technical Implementation
The frontend is built with React, Vite, Tailwind CSS, shadcn/ui, Recharts, @mysten/dapp-kit, and wouter, utilizing TanStack Query v5 for data fetching and WebSockets. The backend uses Express.js and PostgreSQL (Drizzle ORM), featuring API endpoints, a DEX execution engine, the Triton Signal Engine, a Typus Perps DEX adapter, wallet/coin managers, a learning engine, a Pyth Oracle price service, and a position monitor. A shared layer defines Drizzle schemas, Zod schemas, TypeScript types, SUI constants, bundle types, and technical indicator logic.

**Performance Tracker**: A backend time-series analytics system (`server/performance-tracker.ts`) that snapshots portfolio economic value, PnL, regime, win rate, open positions, and signal data every 5 minutes into the `performance_log` PostgreSQL table. `classifyLossReason()` flags counter-trend trades, range-chop, low win rate, overexposure, and consecutive losses. `getLossAnalysis()` aggregates top loss drivers, regime EV deltas, recent trend direction, and produces recommendations.

**Open Position Display Fix**: `FundStatus` component now uses `ACTIVE_STATUSES = ["open", "pending_open", "closing", "pending_close"]` to ensure guardian-tracked positions in `closing` state remain visible in the agent card.

**Deposit-Based Ownership Filter**: `/api/agents` and `/api/portfolio/canonical-snapshot` now support `?ownerWallet=<address>` to look up agents based on deposit address, improving filtering for all existing agents and ensuring correct display for the Portfolio Verifier and Performance Tracker.

**Deep Pullback/Deep Bounce Signal Entries**: Extends the Triton signal engine with two new mean-reversion entry paths for the TREND regime. These capture "buy the dip" and "sell the bounce" opportunities when price extends beyond regular pullback thresholds, using ATR-based SL/TP and requiring confirmed HTF direction.

## External Dependencies
-   **Typus Perps:** On-chain perpetuals trading protocol on SUI
-   **Pyth Oracle (Hermes API):** Real-time SUI/USD price feed
-   **PostgreSQL:** Relational database
-   **Sui Blockchain:** SUI mainnet