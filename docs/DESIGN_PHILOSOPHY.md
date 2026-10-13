# Off Grid — Design Philosophy (shared source of truth)

> Replaces `brand/DESIGN_PHILOSOPHY.md` (synced into each product's `docs/`). This is the new
> direction: premium, alive and luminous, replacing the earlier flat, terminal-brutalist look.

This is the canonical, cross-platform design philosophy for Off Grid. Every surface — Off Grid
Desktop, the browser extension, Off Grid Mobile, the Console, the website and every landing page —
inherits from here. When a platform doc and this doc disagree on a shared principle, this doc
wins. Platform docs own only the mechanics: component libraries, token accessors and layout
density.

The references are sentient-os.ai, underdog.ai and getoffgridai.co.

---

## The disposition

Off Grid is private, on-device and fast. The interface should feel like that: calm, precise and
**alive**. Every surface responds to the person using it — to the pointer, to a press, to typing,
to scrolling, to work finishing — and the parts respond together, as one system, not as a pile of
widgets. Quiet does not mean flat. Depth, light and motion carry the brand where other products
reach for colour and ornament.

**Calm, luminous, alive. Lean, never bulky.**

---

## Shared principles (binding on every platform)

### 1. Alive, in orchestrated harmony

Everything reacts: load, hover, press, drag, focus, typing, scrolling, value changes, loading and
completion. Reactions are coordinated, not per widget:

- The pointer's light spills onto nearby surfaces, not only the hovered one.
- A press sends a soft wave through the surfaces around it.
- Focus draws light to the focused field; its edge glows while you are inside it.
- Loading shimmers in unison; a finished result settles with one soft flash.
- Content arrives in sequence; nothing pops in or snaps away.

One shared system produces this — the `@offgrid/ui` alive layer. Products adopt it; they do not
build their own.

### 2. Layered depth

Build depth with layers of light, not with heavy boxes. A living background (slow breathing
light, a faint lattice) sits behind translucent surfaces with hairline edges and a faint top
highlight. Popups and dialogs are glass: blurred, lifted, with the page receding behind them.
Shadows are soft and wide, never hard or dark-edged.

### 3. One luminous accent: emerald

- Dark mode: `#34D399`
- Light mode: `#059669`

Emerald is the only accent, and it is the light source: primary actions carry a soft emerald
halo, active and focused things glow, the one important element on a screen is the brightest
thing on it. Everything else is a monochrome hierarchy. Do not add a second accent or colour-code
information. Semantic red exists only for errors and destruction.

### 4. Type: a lean sans, with mono for detail

- **Geist** (sans) for reading text, controls and titles.
- **Geist Mono** for small uppercase labels, indices, numbers, timestamps, keys and code.

Weights stay light to regular (300–500). Titles are large, light and slightly tightened.
Hierarchy comes from size, weight, tone and space — not from colour.

### 5. Lean and compact

Controls are slim and precise (32px default height on desktop, hairline borders, 8–12px radius,
fully round for pills and segmented controls). Padding is generous between groups and tight
within them. Nothing thick, nothing bulky, no boxes inside boxes.

### 6. Motion is the language

Motion explains state; it is not decoration, and it is never optional.

- Presses give way and spring back. Hover lifts slightly and brightens.
- Popups roll open from their trigger and their items cascade in; they leave the same way.
- Dialogs rise from 0.94 with blur while the page recedes.
- Disclosures roll open; values roll rather than swap; progress eases.
- Timings: micro 90–180ms · hover and spring 300–460ms · reveal 420–760ms. Use the shared easing
  tokens (`--og-ease-out`, `--og-ease-spring`); never invent timings.
- Animate transform, opacity, filter and light. Never animate `translate` on centred overlays.
- Always honour `prefers-reduced-motion`.

### 7. Tokens, not magic numbers

Colour, spacing, type and motion come from `@offgrid/design` and the `@offgrid/ui` layers. No
hard-coded hex in components. Light and dark flip through tokens.

### 8. Sensible defaults, accessible always

Nothing needs configuring before it works. Icon buttons have `aria-label`, images have `alt`,
text meets 4.5:1 contrast, focus is always visible, and every control works from the keyboard.

### 9. Use the space of the host surface

Desktop uses its width: grids, master-detail, side panels, dense tables. The extension panel is a
400px surface opened for seconds: one primary action, nothing to scroll for. Mobile is a focused
vertical flow. Never imitate another platform.

### Anti-patterns (avoid everywhere)

Flat dead surfaces with no response · things that pop or snap · thick borders and heavy boxes ·
hard or dark drop shadows · multiple accents or rainbow gradients · colour-coded information ·
decorative motion that explains nothing · motion that ignores reduced-motion · emojis in the UI ·
clutter and boxes inside boxes.

---

## Where the system lives

`@offgrid/ui` (`wednesday-solutions/component-library-animations`, consumed as
`@offgrid/operator-ui`) ships everything a product needs to adopt this direction:

| Layer                          | Import                                                                          | What it does                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Alive motion, slot dialect     | `@offgrid/operator-ui/alive.css`                                                | Motion and light for shadcn/Radix and Base UI primitives (`data-slot`, `data-state`) |
| Alive motion, semantic dialect | `@offgrid/operator-ui/alive-semantic.css`                                       | The same feel for plain HTML and ARIA under a `[data-og-alive]` root                 |
| Conductor                      | `@offgrid/operator-ui/operator/alive` (`AliveProvider`, `LivingField`)          | Pointer light, press waves, settle pulses, busy signal, the living background        |
| Host primitives                | `@offgrid/operator-ui/ogad/ui/*`, `@offgrid/operator-ui/extension/*`            | Drop-in replacements for each product's primitives, same APIs                        |
| Host skin                      | `@offgrid/operator-ui/ogad/skin.css`, `@offgrid/operator-ui/extension/skin.css` | Re-renders each product's existing utility vocabulary in this direction              |

Platform docs say how each product wires these in.
