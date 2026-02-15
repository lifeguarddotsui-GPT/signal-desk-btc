# Blue Water Agents - AI Trading Platform

## Overview
Blue Water Agents is a Web3 AI trading platform featuring a dual-agent architecture where execution agents are paired with signal sub-agents that autonomously trade SUI-PERP perpetual contracts. The platform provides a comprehensive Market Dashboard with live Pyth Oracle data, professional charting tools, and AI Signal Reasoning. Users can deploy and manage agents, view their performance, claim rewards, and monitor protocol-wide statistics. A key focus is on verifiable on-chain transactions; all agents must be user-created and funded with real, verifiable transactions. The project aims to provide a robust, transparent, and user-centric platform for AI-driven perpetual futures trading on Web3.

## User Preferences
Not specified.

## System Architecture
The platform is built with a React, Vite, Tailwind, and shadcn/ui frontend, utilizing `@mysten/dapp-kit` for SUI wallet integration. The backend runs on Express.js with PostgreSQL (Drizzle ORM) and a WebSocket server for real-time updates.

**Core Components:**
- **Dual-Agent System:** Each deployed agent comprises an Execution Agent (manages wallet, balances, orders, positions, risk) and a Signal Sub-Agent (performs indicator analysis, generates trading signals based on a 3-of-6 condition score). Signal agents are automatically created upon execution agent deployment.
- **DEX Execution Engine:** A unified execution path (`executeSignalForAgent`) uses a common `DexAdapter` interface, supporting Typus Perps (direct on-chain Move calls to `create_trading_order`, Pyth oracle pricing, up to 50x leverage, package `0xf60e3542...`). No simulation fallback — trades must succeed on-chain with a real txDigest or they are rejected entirely (no balance deduction for failed trades). Enforces `MAX_OPEN_POSITIONS_PER_AGENT = 1` and a 120-second cooldown for same-direction trades. Agent wallets are generated with `Ed25519Keypair` and encrypted using `NaCl secretbox`. Agents are always in auto-trade mode (no manual mode option). Astros was removed to focus exclusively on Typus Perps. FlowX was removed as it only supports spot (CLMM) trading, not perpetuals.
- **Transaction Safety Layer:** Per-wallet TX queue (`tx-queue.ts`) serializes all transactions to prevent concurrent gas object reuse. CoinManager (`coin-manager.ts`) fetches wallet coins sorted by balance, asserts 0.05 SUI minimum gas reserve. Safe execute wrapper (`safe-execute.ts`) sets explicit `setGasPayment` with all coins, retries up to 3 times with backoff on stale object/gas errors. Gas budget is 50M MIST (0.05 SUI). Market engine awaits trades sequentially (no fire-and-forget). Execution engine performs gas health preflight check before trade attempts. **Dry-run preflight**: Before submitting real transactions, dry-run validates the TX on-chain to catch version mismatches and parameter errors before spending gas.
- **Transaction Allowlist:** Only approved Move call targets are permitted: `trading::create_trading_order`, `oracle::update_with_signature`, and `0x2::coin::zero`. Any unauthorized contract call is blocked before signing, preventing wallet drain from rogue calls.
- **Circuit Breaker:** Per-agent consecutive failure tracking. After 3 consecutive failures, the agent is auto-paused with error status to prevent wallet drain. Resets on successful trade.
- **Daily Spend Cap:** Per-agent tracking of failed transaction gas costs (~0.0033 SUI each). Agent is auto-paused when daily failed gas exceeds 0.05 SUI or 10 failed transactions.
- **Oracle Integration (Feb 2026):** Primary price source is Pyth Network's Hermes API (`hermes.pyth.network`) for SUI/USD price feed. Price is validated before every trade. Typus's signed oracle API (`update_with_signature`) is used opportunistically as a best-effort oracle update in the transaction when available, but trades proceed without it if the API is unavailable (Typus keepers maintain oracle freshness). The old `oracle::update_with_pyth_usd` approach was abandoned due to version_check MoveAbort errors. **Slippage buffer**: 200bps applied to triggerPrice using BigInt math (long: oracle + 2%, short: oracle - 2%) to prevent `oracle_mismatched` MoveAbort. Stale price guard rejects trades if oracle age > 30s. Oracle mismatch cooldown (5s) prevents rapid retry spam.
- **Gas Management (`gas.ts`):** Two-tier gas policy: `MIN_EXECUTABLE_GAS = 0.005 SUI` (hard stop for empty wallets) and `COLLATERAL_GAS_RESERVE = 0.10 SUI` (soft reserve for position sizing). Dynamic gas budgeting via `computeSafeGasBudget()` caps budget at 95% of available balance, preventing "gas budget exceeds balance" errors. Supports coin merging for fragmented wallets and dry-run gas estimation.
- **Transaction Recovery:** Endpoints (`/api/recovery/analyze-tx`, `/api/recovery/import-deposit`) exist for restoring lost deposit records from on-chain data, ensuring idempotency and validating protocol fees.
- **Price Service:** Integrates live Pyth Oracle pricing.
- **Indicators:** Shared library for Connors RSI, DEMA, TEMA, and RSI Divergence calculations.
- **Profit Sharing:** Agents support configurable `rewardSharePct` for splitting profits between claimable rewards and reinvestment.
- **Win Rate Tracking & Portfolio Value:** Automatically calculated from closed positions and dynamically displayed, including balance, locked collateral, and unrealized PnL.
- **Signal Engine:** Generates long/short signals per signal agent based on a score-based system (3-of-6 conditions).
- **UI/UX Design:** Dark crypto trading theme with teal primary color (hsl 173 80% 40%) and CSS variable-based chart colors for theme compatibility. Mobile-first responsive design is implemented.
- **Protocol Fee:** A 2% fee is applied to all agent deposits, directed to a designated protocol address.
- **Transaction Finality:** Frontend uses `waitForFinalized()` polling to confirm on-chain transaction finality before updating the UI.
- **Money Flow Debugger:** A `/debug/ledger` page offers forensic transaction tracing and digest verification.
- **SUI Verification:** On-chain transaction validation and real-time balance checking via `SuiJsonRpcClient`.
- **Agent Ownership:** Agents are tied to the creator's wallet address, restricting deletion and modification to owners only. Deletion is blocked for agents with open positions. All related data (deposits, rewards, bundles, protocol fees) is cleaned up on deletion.
- **Depositor Collateral Control:** Deposits are tracked per-wallet, allowing original depositors to withdraw their collateral.
- **Reward Access Control:** Only wallets that created or funded an agent can claim its rewards. Claims require wallet address verification and on-chain transaction signing.
- **Wallet-Signed Withdrawals:** All withdrawals and collateral removals require the user to sign an authorization transaction in their SUI wallet before the backend processes the transfer. This ensures explicit user consent for all fund movements.
- **DEX Readiness Checks:** Each adapter implements `isReady()` to verify real contract addresses before attempting trades. Execution errors are tracked per-agent with `lastExecutionError` and `lastExecutionAt` fields.
- **Execution Bundles:** Created for both successful and rejected trade attempts, giving visibility into why trades succeed or fail.
- **Verified-Only Data:** All API endpoints filter simulated data, ensuring that protocol overviews, rewards, and wallet summaries only display verified on-chain records.
- **Instruction Bundles:** A system for queuing and executing instruction bundles, with granular execution records.
- **Move Contracts:** Custom Move contracts (`Vault.move`, `TradeCap.move`, `Rewards.move`) handle collateral, trading caps, and reward management.

## External Dependencies
- **Typus Perps:** Fully on-chain perps via direct Move calls to `create_trading_order` with Pyth oracle integration and up to 50x leverage. Contract: `0xf60e3542f1c65a77d9bcdffd5d8a712a46b935ec51b9052e5ad98888e0392d09`.
- **Pyth Oracle:** For live market data pricing.
- **PostgreSQL:** Primary database for persistent storage, managed with Drizzle ORM.
- **Sui Blockchain:** For all on-chain transactions, wallet interactions, and smart contract execution.
- **Vite:** Frontend build tool.
- **Tailwind CSS:** For styling.
- **shadcn/ui:** UI component library.
- **Recharts:** For charting.
- **@mysten/dapp-kit:** For SUI wallet integration.
- **Express.js:** Backend web framework.
- **NaCl (Networking and Cryptography library):** Used for secure keypair encryption.