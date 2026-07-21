GM: paint one or more grid tiles to a terrain kind, reshaping the map live.

Passability changes reroute any agent mid-walk (or halt them if you wall off their destination). Terrain is only the ground, so painting a tile does not add or remove any resource — harvestables live on tokens, not tiles.

Register a new kind with register_terrain first.

**Example**

```
set_terrain({at:[{x:22,y:14},{x:22,y:15},{x:23,y:15}], to:'lava'})
```
