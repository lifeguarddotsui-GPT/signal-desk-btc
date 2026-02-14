module bluewater::vault {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;

    struct CollateralVault<phantom T> has key {
        id: UID,
        total: Balance<T>,
    }

    struct VaultPosition<phantom T> has key, store {
        id: UID,
        owner: address,
        shares: u64,
    }

    public fun init_vault<T>(ctx: &mut TxContext): CollateralVault<T> {
        CollateralVault {
            id: object::new(ctx),
            total: balance::zero<T>(),
        }
    }

    public fun deposit<T>(
        vault: &mut CollateralVault<T>,
        coin_in: Coin<T>,
        ctx: &mut TxContext
    ): VaultPosition<T> {
        let amt = coin::value(&coin_in);
        balance::join(&mut vault.total, coin::into_balance(coin_in));
        VaultPosition<T> {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            shares: amt,
        }
    }

    /// Withdraw ANY % of collateral by burning shares
    /// pct_bps: 1..=10000 (basis points, e.g. 5000 = 50%)
    public fun withdraw_percent<T>(
        vault: &mut CollateralVault<T>,
        pos: &mut VaultPosition<T>,
        pct_bps: u64,
        ctx: &mut TxContext
    ): Coin<T> {
        assert!(pct_bps > 0 && pct_bps <= 10000, 0);
        assert!(pos.owner == tx_context::sender(ctx), 1);

        let shares_to_burn = (pos.shares * pct_bps) / 10000;
        assert!(shares_to_burn > 0, 2);

        pos.shares = pos.shares - shares_to_burn;

        let out_bal = balance::split(&mut vault.total, shares_to_burn);
        coin::from_balance(out_bal, ctx)
    }

    public fun transfer_position<T>(pos: VaultPosition<T>, to: address) {
        transfer::transfer(pos, to);
    }

    public fun shares<T>(pos: &VaultPosition<T>): u64 {
        pos.shares
    }

    public fun total_balance<T>(vault: &CollateralVault<T>): u64 {
        balance::value(&vault.total)
    }
}
