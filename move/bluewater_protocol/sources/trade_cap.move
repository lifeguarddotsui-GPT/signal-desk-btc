module bluewater::trade_cap {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;

    struct TradeCap has key, store {
        id: UID,
        user: address,
        max_notional_usd: u64,
        max_leverage: u64,
        is_active: bool,
    }

    public fun new_cap(
        max_notional_usd: u64,
        max_leverage: u64,
        ctx: &mut TxContext
    ): TradeCap {
        TradeCap {
            id: object::new(ctx),
            user: tx_context::sender(ctx),
            max_notional_usd,
            max_leverage,
            is_active: true,
        }
    }

    public fun pause(cap: &mut TradeCap, ctx: &mut TxContext) {
        assert!(cap.user == tx_context::sender(ctx), 0);
        cap.is_active = false;
    }

    public fun resume(cap: &mut TradeCap, ctx: &mut TxContext) {
        assert!(cap.user == tx_context::sender(ctx), 1);
        cap.is_active = true;
    }

    public fun is_active(cap: &TradeCap): bool {
        cap.is_active
    }

    public fun max_notional(cap: &TradeCap): u64 {
        cap.max_notional_usd
    }

    public fun max_leverage(cap: &TradeCap): u64 {
        cap.max_leverage
    }

    public fun owner(cap: &TradeCap): address {
        cap.user
    }

    public fun transfer_to_executor(cap: TradeCap, executor: address) {
        transfer::transfer(cap, executor);
    }
}
