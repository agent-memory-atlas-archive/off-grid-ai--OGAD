# Off Grid AI Desktop — Design

> Replaces OGAD `docs/DESIGN.md`. New direction: premium, alive and luminous, replacing flat
> terminal brutalism.

Read [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) before any Desktop UI change. It is
synchronized from the canonical `brand/DESIGN_PHILOSOPHY.md`. Shared principles come from there;
this document gives Desktop layout, implementation and interaction details.

---

## Soul

**Calm, luminous, alive. Lean, never bulky.** Every surface responds to the person using it, and
the parts respond together. Depth comes from layers of light, not from heavy boxes.

- **Type:** Geist for reading text, controls and titles; Geist Mono for small uppercase labels,
  numbers, timestamps, keys and code. Weights 300–500.
- **Single accent: emerald** — `#34D399` (dark) / `#059669` (light). It is the light source:
  primary actions glow, focus and active states glow, everything else is monochrome.
- **Base:** near-black `#0A0A0A` (dark) / white (light), with a living background behind
  translucent surfaces.
- **Hierarchy through size, weight, tone and space**, never colour.
- **Lean:** 32px controls, hairline borders, 9–12px radius (pills fully round), soft wide shadows.

---

## What changes for desktop

Desktop is a wide, mouse-driven, multi-window canvas.

| Concern    | **Desktop**                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------- |
| Canvas     | Wide: multi-column grids, master-detail, side panels, dense tables. Use the width.          |
| Navigation | Persistent left icon rail; the active item glows emerald.                                   |
| Pointer    | Hover is first-class: surfaces catch the pointer's light, borders brighten, actions reveal. |
| Density    | Dense within groups, generous between them.                                                 |
| Input      | Keyboard shortcuts everywhere repeated (Cmd+K, Cmd+[ / ]), Enter to submit.                 |
| Chrome     | Window plus menu-bar tray; the title is always "Off Grid AI Desktop".                       |
| Detail     | Detail screens and side panels, never a detail crammed into a row.                          |

---

## Implementation

Desktop is React + Tailwind v4. The look comes from `@offgrid/operator-ui` in three layers,
wired once in the renderer (see the library's `docs/HOST_INTEGRATION.md`):

1. **Skin** — `@offgrid/operator-ui/ogad/skin.css` re-renders the existing utility vocabulary
   below. Write the classes as listed; the skin supplies the new look.
2. **Primitives** — `src/renderer/src/components/ui/*` re-export
   `@offgrid/operator-ui/ogad/ui/*`. Same APIs, premium visuals.
3. **Motion** — `@offgrid/operator-ui/alive.css` plus `AliveProvider` (and `LivingField` for the
   background) give every primitive and surface its reactions.

```
Base        bg-neutral-950            translucent base over the living background
Surface     bg-neutral-900/40–60      glass layer, hairline edge, faint top highlight
Surface+    bg-neutral-800            active pills, badges, inputs (a slightly brighter layer)
Borders     border-neutral-800        hairline · hover border-neutral-700 · focus border-green-500 (glows)
Accent      text-green-500 / bg-green-500   emerald; bg fills glow
Text tiers  text-white → text-neutral-300 → text-neutral-500 → text-neutral-600
Radius      rounded-md (9px) · rounded-lg / rounded-2xl for cards · rounded-full pills
Font        body is Geist; `uppercase`, `tabular-nums`, code, kbd, pre and time are Geist Mono
```

Never hard-code hex or shadows in components; the skin and tokens own them.

---

## Text hierarchy

| Role             | Tailwind                                                          | Use                               |
| ---------------- | ----------------------------------------------------------------- | --------------------------------- |
| **TITLE**        | `text-lg tracking-tight text-white` (large, light)                | one per screen                    |
| **BODY**         | `text-sm text-neutral-200/300`                                    | content, list items, controls     |
| **SUBTITLE**     | `text-sm text-white` / section `<h2>`                             | section, card and dialog titles   |
| **DESCRIPTION**  | `text-xs text-neutral-500`                                        | explanation under a title         |
| **META / LABEL** | `text-[10px]–[11px] uppercase tracking-wide text-neutral-500/600` | labels, counts, timestamps (mono) |

---

## Components

- **Sidebar** — left icon rail; the active item glows emerald, hover brightens.
- **Screen header** — title left; a segmented control or action right; hairline
  `border-b border-neutral-900`, `px-6 py-4`.
- **Cards** — `rounded-2xl border border-neutral-800 bg-neutral-900/40–60 p-5–6`; hover
  `border-neutral-700`. The skin lights and lifts them.
- **Segmented control** — `@offgrid/operator-ui/operator/segmented`, or
  `rounded-full border border-neutral-800 p-0.5` with an active pill; the highlight glides.
- **Icon buttons first** — any action with a clear glyph (stop, pause, continue, retry, copy,
  delete, edit, close, send, download, refresh, settings, add, more) is a `size="icon-*"` button
  with the label as `aria-label` and a tooltip. Words only when an icon would be ambiguous or for
  the screen's one primary call to action.
- **Buttons** — `ui/button` variants. Hand-built primary: `bg-green-500 text-neutral-950`;
  secondary: `border border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500`.
- **Inputs** — `rounded-md border border-neutral-800 bg-neutral-950 text-neutral-200`; focus glows.
- **Lists / rows** — compact rows with a trailing chevron that reveals on hover; click → detail.
- **Badges** — `rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400`; active
  ones emerald.
- **Popups, menus, tooltips, dialogs** — the `ui/*` primitives: glass, spring in from their
  trigger, items cascade, exits animate.
- **Empty states** — one muted icon, one line, one action when useful.
- **Logos** — real brand marks, bare.

---

## Interaction and motion

**Nothing pops. Every state change animates, and the parts move together.**

- **Pointer:** surfaces near the pointer catch its light; a press sends a soft wave through
  nearby surfaces. This is automatic once `AliveProvider` is mounted.
- **Hover:** lift slightly, brighten borders and text, reveal secondary actions
  (`opacity-0 group-hover:opacity-100`).
- **Press:** give way (scale ~0.96) and spring back.
- **Focus:** the field's edge glows emerald; keyboard focus shows a soft ring.
- **Loading:** mark busy regions `aria-busy` or use the Button `loading` prop; the page's busy
  signal quickens the primary glow. Skeletons share one sweep. Keep old content visible while
  refreshing.
- **Results:** status lines use `role="status"`; when one changes it settles with a soft flash.
- **Panels and dialogs:** rise from 0.94 with blur; the page recedes; exits animate. Never animate
  `translate` on centred overlays (Tailwind centres them with it).
- **Timings:** micro 90–180ms, hover and spring 300–460ms, reveal 420–760ms; use
  `--og-ease-out` and `--og-ease-spring`.
- **Reduced motion:** always honoured, by the library layers and by `main.css`.

---

## Anti-patterns

❌ Flat dead surfaces · things that pop or snap · thick borders and boxes inside boxes · hard dark
shadows · a second accent or rainbow gradients · colour-coded status · decorative motion ·
emojis in the UI.
❌ **Desktop-specific:** a phone-width column on a wide screen · ignoring hover · cramming detail
inline instead of using panels.

---

## Checklist

- [ ] Geist for text, Geist Mono for labels, numbers and code.
- [ ] Emerald is the only accent and the light source.
- [ ] Uses the full width where it helps.
- [ ] Hierarchy from size, weight and space.
- [ ] Every interactive state animates; overlays exit smoothly; reduced motion respected.
- [ ] Results in `role="status"`, loading in `aria-busy`.
- [ ] Primitives from `ui/*`; no hard-coded colours or shadows.
- [ ] Clear actions are icon buttons with an `aria-label` and tooltip, not text labels.
