export const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

export const BLUEWATER_PACKAGE_ID = process.env.BLUEWATER_PKG_ID || "";
export const COLLATERAL_VAULT_ID = process.env.COLLATERAL_VAULT_ID || "";
export const REWARDS_VAULT_ID = process.env.REWARDS_VAULT_ID || "";
export const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export const MOVE_TARGETS = {
  vaultDeposit: `${BLUEWATER_PACKAGE_ID}::vault::deposit`,
  vaultWithdrawPercent: `${BLUEWATER_PACKAGE_ID}::vault::withdraw_percent`,
  tradeCapNew: `${BLUEWATER_PACKAGE_ID}::trade_cap::new_cap`,
  tradeCapPause: `${BLUEWATER_PACKAGE_ID}::trade_cap::pause`,
  tradeCapResume: `${BLUEWATER_PACKAGE_ID}::trade_cap::resume`,
  tradeCapTransfer: `${BLUEWATER_PACKAGE_ID}::trade_cap::transfer_to_executor`,
  rewardsAccrue: `${BLUEWATER_PACKAGE_ID}::rewards::accrue`,
  rewardsClaim: `${BLUEWATER_PACKAGE_ID}::rewards::claim`,
  rewardsFund: `${BLUEWATER_PACKAGE_ID}::rewards::fund`,
} as const;

export const ASTROS_API_BASE = "https://api.astros.xyz";

export const VENUE_MAP: Record<string, string> = {
  astros: "ASTROS_PERPS",
} as const;
