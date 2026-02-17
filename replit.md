# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform enabling autonomous trading of SUI-USDC perpetual contracts using a dual-agent architecture. The platform offers a Market Dashboard with live Pyth Oracle data, professional charting, and AI Signal Reasoning. Users can deploy, manage, and monitor agents, claim rewards, and view protocol statistics. A core tenet is transparent, verifiable on-chain transactions, ensuring all agent actions are user-created and funded with real, auditable transactions. The project aims to deliver a robust, transparent, and user-centric platform for AI-driven perpetual futures trading in the Web3 ecosystem.

## User Preferences
Not specified.

## System Architecture
The platform features a React, Vite, Tailwind, and shadcn/ui frontend integrated with SUI wallets via `@mysten/dapp-kit`. The backend uses Express.js, PostgreSQL (Drizzle ORM), and a WebSocket server for real-time data.

**Core Architectural Decisions & Features:**

-   **Dual-Agent System:** Each agent deployment includes an Execution Agent (manages wallet, balances, orders, positions, risk) and an automatically created Signal Sub-Agent (performs indicator analysis and generates trading signals based on a 4-of-7 condition score with margin requirement).
-   **DEX Execution Engine:** Utilizes a unified `DexAdapter` interface for Typus Perps, allowing direct on-chain Move calls. Trades require successful on-chain execution with a real `txDigest`; no simulation fallback. Supports up to 5 concurrent positions per agent with locked collateral tracking and a 30-second cooldown for same-direction trades. Collateral bounds (`minCollateral`, `maxCollateral`) are enforced per agent, and a 90% safety margin is applied to available balance for position sizing. Liquidation detection auto-closes positions on database with full collateral loss. On-chain `onChainPositionId` is critical for opening and closing positions.
-   **Transaction Safety Layer:** A per-wallet transaction queue serializes all transactions. `CoinManager` ensures a minimum gas reserve. `safe-execute` retries transactions with backoff and uses explicit `setGasPayment`. A dry-run preflight validates transactions on-chain.
-   **Transaction Allowlist:** Only approved Move call targets and Pyth/Wormhole oracle modules are permitted to prevent rogue contract calls.
-   **Position Monitor:** An independent loop (every 1 second) checks all open positions for stop-loss, take-profit, and emergency liquidation prevention triggers against current Pyth prices. Uses per-agent locks (not global) and per-position close-in-progress locks to allow concurrent position closes across agents while preventing duplicate close attempts. Close attempts must succeed on-chain.
-   **Anti-Liquidation Protection:** Three-tier collateral loss protection system since Typus does not support native on-chain SL/TP orders. (1) Stop-loss auto-tightened against leverage to cap at 50% collateral loss. (2) Hard max collateral loss cap at 50% triggers close regardless of SL setting. (3) Emergency close at 60% collateral loss with highest priority. Positions sorted by priority (emergency > max-loss > SL > TP). Close retries: 4 attempts with progressive delays [200ms, 400ms, 800ms] and fresh price on each retry.
-   **Circuit Breaker:** Tracks consecutive failed `OPEN` operations per agent, pausing the agent for 60 seconds after 3 failures. `CLOSE` operations bypass the circuit breaker.
-   **Phantom Close Prevention:** Prevents positions from being marked as closed in the database without a corresponding on-chain close transaction. Startup integrity checks detect and reopen such positions for proper on-chain closure.
-   **Balance Source of Truth:** Agent balance is derived from on-chain wallet SUI plus locked collateral from only OPEN positions.
-   **Daily Spend Cap:** Agents are automatically paused if daily failed transaction gas costs or count exceed predefined thresholds.
-   **Oracle Integration:** Primary price source is Pyth Network's Hermes API for SUI/USD. Price validation includes a 500bps slippage buffer and a stale price guard (age > 30s). SUI-collateral SUI perps on Typus require the SUI oracle passed twice to `create_trading_order` after updating its PriceInfoObject.
-   **Gas Management:** Employs a two-tier gas policy (`MIN_EXECUTABLE_GAS`, `COLLATERAL_GAS_RESERVE`) and dynamic budgeting to prevent 'gas budget exceeds balance' errors. Supports coin merging.
-   **Transaction Recovery:** Endpoints for analyzing and importing lost deposit records from on-chain data.
-   **Indicators:** Shared library for Connors RSI, DEMA, TEMA, and RSI Divergence.
-   **Profit Sharing:** Configurable `rewardSharePct` for profit distribution.
-   **Win Rate Tracking & Portfolio Value:** Automatically calculated and displayed.
-   **Signal Engine (v2):** Generates long/short signals based on a 7-condition scoring system requiring 4-of-7 agreement with a minimum margin.
-   **UI/UX Design:** Dark crypto trading theme with teal primary color, CSS variable-based charting, and mobile-first responsive design.
-   **Protocol Fee:** A 2% fee on all agent deposits.
-   **Transaction Finality:** Frontend waits for `waitForFinalized()` before UI updates.
-   **Money Flow Debugger:** Forensic transaction tracing and digest verification.
-   **SUI Verification:** On-chain transaction validation and real-time balance checks via `SuiJsonRpcClient`.
-   **Agent Ownership:** Agents are tied to the creator's wallet; deletion requires owner authentication and is blocked if positions are open.
-   **Depositor Collateral Control:** Original depositors can withdraw their collateral.
-   **Reward Access Control:** Rewards can only be claimed by wallets that created or funded an agent, requiring wallet verification and on-chain signing for SUI transfers from agent wallets to the user.
-   **Wallet-Signed Withdrawals:** All fund withdrawals require explicit user authorization via an on-chain signed transaction.
-   **DEX Readiness Checks:** Adapters include `isReady()` to verify contract addresses.
-   **Execution Bundles:** Created for all trade attempts, successful or not, for visibility.
-   **Verified-Only Data:** API endpoints filter simulated data, ensuring displayed information reflects only verified on-chain records.
-   **Instruction Bundles:** System for queuing and executing instruction bundles with granular execution records.
-   **Move Contracts:** Custom Move contracts (`Vault.move`, `TradeCap.move`, `Rewards.move`) manage collateral, trading caps, and rewards.

## External Dependencies
-   **Typus Perps:** On-chain perpetuals trading protocol.
-   **Pyth Oracle:** Real-time market data.
-   **PostgreSQL:** Relational database.
-   **Sui Blockchain:** Underlying blockchain platform.
-   **Vite:** Frontend build tool.
-   **Tailwind CSS:** Utility-first CSS framework.
-   **shadcn/ui:** UI component library.
-   **Recharts:** Charting library.
-   **@mysten/dapp-kit:** SUI wallet integration.
-   **Express.js:** Backend web application framework.
-   **NaCl (Networking and Cryptography library):** Used for secure keypair encryption.