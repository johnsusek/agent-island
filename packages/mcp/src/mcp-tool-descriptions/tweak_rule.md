GM: shallow-merge fields into an existing rule — the lightweight tuning knob ("fire burns faster": tweak its rate).

Pass the rule's id and only the fields to change, e.g.

```
{id:"cold-snap", fields:{rate:-4}}
```

Update the `description` here too when a tweak changes what the rule effectively does.

This is also how you retune pacing on a live rule:

- `{id:"raid", fields:{cooldown:40}}` — slows a raid down
- `{fields:{chance:0.02}}` — makes it rarer
- `{fields:{priority:5}}` — makes it run earlier in its phase
- `{fields:{conflict:"highest"}}` — changes how its threshold `set` effects resolve against others on the same stock

Adding a synonym to a live action is the same call: `{id:"mine_stone", fields:{aliases:["mine","quarry","chip_stone","crack_geode"]}}` - pass the whole list, since the merge replaces it wholesale.

The merge is shallow (a nested field is replaced wholesale, not deep-merged) and cannot delete a field — to drop one, remove_rule and re-add.

Only `id` is locked; every other field including `phase`/`kind` can be changed, so a careless tweak can reshape the rule — the result is re-validated and rejected if its phase/kind becomes invalid.

Like add_rule, every tweak is automatically dry-run against a copy of the world; read the result's `dryRun.warnings` to catch a patch that makes the rule throw. The same strict-write rule applies here too: an `adjust`/`set` target you patch in must already exist on the entities it will touch (see add_rule's "Stock writes are strict") — a tweak that repoints `target` at an undeclared name errors exactly like a fresh rule would.
