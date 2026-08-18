# @narumitw/pi-btw

## 0.54.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.54.0

### Minor Changes

- b5c0682: Add native mouse-wheel and trackpad scrolling to side-thread transcript history.

## 0.53.0

### Minor Changes

- d97edfd: Add a native main-session tree picker that starts a fresh side thread from any selected branch without switching the main conversation.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.52.0

### Minor Changes

- f3d76af: Add a Same as main thread thinking option that starts new side threads from the current main thread level while keeping shortcut changes local.

## 0.51.0

### Minor Changes

- 69e8485: Add local fuzzy search to the in-memory Resume thread choice.

## 0.50.0

### Minor Changes

- be8d492: Add an in-memory Resume picker to `/btw` so the current Pi session can continue any non-empty side thread by its first question while `/btw <question>` remains a fresh-thread fast path.

## 0.49.7

### Patch Changes

- 3f33860: Run side threads in a dedicated full-screen TUI so mouse-drag copying stays stable while the main agent continues producing output in the background.
- 2a2c9c1: Queue Pi-style steering questions while a side-thread answer is running, process them one at a time without touching the main conversation, and report malformed side-model responses without hanging the side UI.

## 0.49.6

### Patch Changes

- a4b44ee: Route side-question completions through Pi's effective runtime provider so custom provider APIs work.
