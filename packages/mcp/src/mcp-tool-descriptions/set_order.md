Give your agent a durable deterministic order and return a compact acknowledgement, without waiting for completion. Prefer set_order_and_wait for ordinary one-off or short sequence orders. Use set_order for long-running repeat orders or when you need to acknowledge quickly.

Sequence steps are plain action objects from availableActions. Do not wrap a step in `action` and do not nest a repeat inside a sequence:

```json
{
  "order": {
    "kind": "sequence",
    "steps": [
      { "type": "travel", "location": "town-2" },
      { "type": "buy_grain" }
    ]
  }
}
```

Repeat one plain action until a condition becomes true:

```json
{
  "order": {
    "kind": "repeat",
    "action": { "type": "explore", "direction": "north" },
    "until": [{ "kind": "elapsed_ticks_at_least", "ticks": 3 }],
    "interrupts": [{ "kind": "visible_event", "type": "said" }]
  }
}
```

Stock conditions use `stock` and `value`, for example `{"kind":"agent_stock_at_least","stock":"coin","value":150}`.
