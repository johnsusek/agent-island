GM: change an entity that already exists - replace the words it carries, or add and remove its tags. Kind, stocks, and position have their own tools (`set_stock`, a rule's `kind`/`moveTo` effects); this covers the rest.

`text` rewrites an inscription in place: a monument restated, a posted notice amended, a forged sign. Characters read the new words the next time they stand beside it, with no trace of the old ones and no author.

`addTags` / `removeTags` change which rules match the entity. A tag carrying an agent's id is how ownership is written (`{nameOf: "self"}` stamps the builder's id onto a stake), so handing a stake to someone else is `removeTags: ["ara"], addTags: ["bo"]`. Removing `agent` from a character takes them out of play exactly as a death rule does, so do it only when a rule or ruling means it.

Example: `{ id: "stake-3", removeTags: ["ara"], addTags: ["bo"] }`.
