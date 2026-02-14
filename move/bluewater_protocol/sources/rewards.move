module bluewater::rewards {
    use sui::object::{Self, UID};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::tx_context::{Self, TxContext};
    use sui::table::{Self, Table};

    struct RewardsVault<phantom R> has key {
        id: UID,
        pool: Balance<R>,
        owed: Table<address, u64>,
    }

    public fun init_vault<R>(ctx: &mut TxContext): RewardsVault<R> {
        RewardsVault {
            id: object::new(ctx),
            pool: balance::zero<R>(),
            owed: table::new(ctx),
        }
    }

    /// Fund reward pool with coins
    public fun fund<R>(v: &mut RewardsVault<R>, coin_in: Coin<R>) {
        balance::join(&mut v.pool, coin::into_balance(coin_in));
    }

    /// Executor/keeper accrues rewards for a user
    public fun accrue<R>(v: &mut RewardsVault<R>, user: address, amt: u64) {
        if (table::contains(&v.owed, user)) {
            let cur = table::borrow_mut(&mut v.owed, user);
            *cur = *cur + amt;
        } else {
            table::add(&mut v.owed, user, amt);
        }
    }

    /// User claims all accrued rewards
    public fun claim<R>(v: &mut RewardsVault<R>, ctx: &mut TxContext): Coin<R> {
        let user = tx_context::sender(ctx);
        assert!(table::contains(&v.owed, user), 0);
        let amt = *table::borrow(&v.owed, user);
        assert!(amt > 0, 1);
        *table::borrow_mut(&mut v.owed, user) = 0;

        let out = balance::split(&mut v.pool, amt);
        coin::from_balance(out, ctx)
    }

    public fun owed_amount<R>(v: &RewardsVault<R>, user: address): u64 {
        if (table::contains(&v.owed, user)) {
            *table::borrow(&v.owed, user)
        } else {
            0
        }
    }

    public fun pool_balance<R>(v: &RewardsVault<R>): u64 {
        balance::value(&v.pool)
    }
}
