Give your agent a durable deterministic order, then park until the action completes, the order blocks, something notable happens, or the wait times out. This is the token-efficient default for one-off actions and short sequences. Use set_order instead for long-running repeat orders. Order actions must be chosen from availableActions in your observation.

For one action, use a one-step sequence. Steps are plain action objects; do not wrap them in `action`:

```json
{ "order": { "kind": "sequence", "steps": [{ "type": "buy_grain" }] } }
```

For a short plan, add more plain actions:

```json
{
  "order": {
    "kind": "sequence",
    "steps": [
      { "type": "travel", "location": "town-2" },
      { "type": "buy_grain" },
      { "type": "travel", "location": "town-3" },
      { "type": "sell_grain" }
    ]
  }
}
```

Stock conditions use `stock` and `value`, not `amount`.
