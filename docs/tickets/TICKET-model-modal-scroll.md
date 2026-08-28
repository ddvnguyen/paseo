# Model config modal not scrollable on mobile web

**Status:** Open
**Priority:** High
**Labels:** bug, app, mobile-web

## Description
On mobile web (PWA or mobile Chrome), the model config modal's model list renders in a plain `<View>` with no scroll mechanism. The `ModelRowList` in `model-browser.tsx:1164` gates `BottomSheetFlatList` on `isNative`, so on mobile web it falls through to a non-scrollable `<View>` fallback.

## Root cause
In `packages/app/src/components/model-browser.tsx`, the `ModelRowList` component has three code paths:
1. `scrolling === "independent"` → `IndependentModelList` (desktop)
2. `isCompact && isNative` → `BottomSheetFlatList` (native mobile)
3. Fallback → plain `<View>` (mobile web — no scroll)

On mobile web, `isCompact=true` and `isNative=false`, so path 2 is skipped and path 3 renders all model rows in a non-scrollable container. Combined with `scrollable={false}` on the `AdaptiveModalSheet`, the entire content area has no scroll.

## Expected behavior
Model list should be scrollable on mobile web, similar to how it works on native mobile.

## Possible fix
Change the gate from `isCompact && isNative` to `isCompact` (or add a web-specific scrollable path using a plain `ScrollView`/`FlatList` instead of `BottomSheetFlatList`).
