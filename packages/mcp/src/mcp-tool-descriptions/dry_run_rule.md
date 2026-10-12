GM: preview a rule without adding it. Nothing in the world changes: not the rules, the stocks, the map, or the GM feed.

Takes the same `rule` object as `add_rule` and runs the same structural validation, so a rule that would be rejected is rejected here too. It then simulates the live rule set with this rule added for `ticks` ticks (default 50) on a disposable copy of the world and returns the `dryRun` report: `warnings` (rule_errors the rule threw) and `notes` (softer findings, such as matching no entity).

If a live rule already has this `id`, the candidate replaces it in the simulation, so this also previews a `tweak_rule`.

Use it to iterate on a rule until its warnings are gone, then `add_rule` it.
