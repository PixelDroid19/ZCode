# Picker selection identity

## Ownership

The catalog providers own the current candidate list. `MentionPlugin` owns the
picker's current keyboard choice, represented by the selected `MentionItem.id`.
The array index is only a rendering and navigation position; it is not the
identity of the selected candidate.

## Behavior

- A live insert or reorder keeps the same enabled candidate selected by id, even
  when its index changes.
- If the selected candidate is removed or becomes disabled, select the first
  enabled candidate in the current list. If none is enabled, Enter and Tab must
  not insert a disabled item.
- A new trigger/query signature starts at the first enabled candidate. That
  choice must already be valid in the render that exposes the new list, before
  an effect has a chance to reconcile state.
- Enter and Tab resolve the current selected id against the current candidate
  list. A stale numeric index must never insert a different candidate.
- Mouse selection uses the id belonging to the currently rendered row, including
  after a live catalog mutation.

## Acceptance

Use the existing browser integration harness with the real React `MentionPlugin`
and Lexical editor. Drive catalog reorder, insertion, removal, and disabled-state
changes through the controlled service boundary. Verify the selected row and the
inserted mention id for keyboard and mouse selection; do not test a copied
selection helper in isolation.
