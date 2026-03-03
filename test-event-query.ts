const { SuiClient } = require("@mysten/sui/dist/cjs/client") as any;
const PKG = "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9";
const wallet = "0x41a31c2b0e0dd3db7c5e5b22b0fc189d8cf3e36fb5578b399d4783a9ae6d07d6";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function main() {
  try {
    const r = await client.queryEvents({
      query: {
        All: [
          { MoveEventType: `${PKG}::position::OrderFilledEvent` },
          { MoveEventField: { path: "/user", value: wallet } }
        ]
      },
      limit: 50,
      order: "descending",
    });
    console.log("All filter: found", r.data.length, "events");
    for (const e of r.data) {
      const p = (e as any).parsedJson;
      console.log(`  order_id: ${p.order_id} new_pos_id: ${p.new_position_id} reduce_only: ${p.reduce_only} linked_pos: ${p.linked_position_id}`);
    }
  } catch(e: any) {
    console.log("All filter error:", e.message?.slice(0,300));
  }
}
main();
