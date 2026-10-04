---
name: gsap-plugins
description: "GSAP plugins: registration, ScrollTo/ScrollSmoother, Flip, Draggable, Inertia, Observer, SplitText, ScrambleText, SVG + physics plugins, CustomEase. Use for plugin questions, scroll-to, flip animations, draggable, SVG drawing, or registration."
license: MIT
---

# GSAP Plugins

## When to Use This Skill

Apply when using or reviewing code that uses GSAP plugins: registering plugins, scroll-to, flip/FLIP animations, draggable elements, SVG (DrawSVG, MorphSVG, MotionPath), text (SplitText, ScrambleText), physics, easing plugins (CustomEase, EasePack, CustomWiggle, CustomBounce), or GSDevTools. ScrollTrigger has its own skill (gsap-scrolltrigger).

**Related skills:** For core tweens use **gsap-core**; for ScrollTrigger use **gsap-scrolltrigger**; for React use **gsap-react**.

## Licensing & Install (important)

Every GSAP plugin is **free**, including for commercial use. Since [Webflow's acquisition of GSAP](https://gsap.com/blog/webflow-GSAP/), Club GSAP is no longer a paid tier and **no plugin requires a membership, license key, or auth token** — this includes formerly Club-only plugins (**SplitText**, **MorphSVG**, etc.).

- ✅ Install everything from the public `gsap` npm package: `npm install gsap`. All plugins are included — import them as `gsap/SplitText`, `gsap/MorphSVGPlugin`, etc.
- ❌ Do **not** generate an `.npmrc` with a GreenSock auth token, suggest the private `npm.greensock.com` registry, or tell users to sign up for Club GSAP to access a plugin. Those instructions are outdated.

## Registering Plugins

Register each plugin once so GSAP (and bundlers) know to include it. Use **gsap.registerPlugin()** with every plugin used in the project:

```javascript
import gsap from "gsap";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { Flip } from "gsap/Flip";
import { Draggable } from "gsap/Draggable";

gsap.registerPlugin(ScrollToPlugin, Flip, Draggable);
```

- ✅ Register before using the plugin in any tween or API call.
- ✅ In React, register at top level or once in the app (e.g. before first useGSAP); do not register inside a component that re-renders. useGSAP is a plugin that needs to be registered before use.

## Scroll

### ScrollToPlugin

Animates scroll position (window or a scrollable element). Use for “scroll to element” or “scroll to position” without ScrollTrigger.

```javascript
gsap.registerPlugin(ScrollToPlugin);

gsap.to(window, { duration: 1, scrollTo: { y: 500 } });
gsap.to(window, { duration: 1, scrollTo: { y: "#section", offsetY: 50 } });
gsap.to(scrollContainer, { duration: 1, scrollTo: { x: "max" } });
```

**Key config (scrollTo object):** see [references/scroll-plugins.md](references/scroll-plugins.md).

### ScrollSmoother

Smooth scroll wrapper (smooths native scroll). Requires ScrollTrigger and a specific DOM structure (content wrapper + smooth wrapper). Use when smooth, momentum-style scroll is needed. See GSAP docs for setup; register after ScrollTrigger. DOM structure would look like: 
**Setup & DOM structure:** see [references/scroll-plugins.md](references/scroll-plugins.md).

## DOM / UI

### Flip

Capture state with `Flip.getState()`, then apply changes (e.g. layout or class changes), then use `Flip.from()` to animate from the previous state to the new state (FLIP: First, Last, Invert, Play). Use when animating between two layout states (lists, grids, expanded/collapsed).

```javascript
gsap.registerPlugin(Flip);

const state = Flip.getState(".item");
// change DOM (reorder, add/remove, change classes)
Flip.from(state, { duration: 0.5, ease: "power2.inOut" });
```

**Full config (Flip.from vars):** see [references/dom-ui-plugins.md](references/dom-ui-plugins.md).

#### More information

https://gsap.com/docs/v3/Plugins/Flip

### Draggable

Makes elements draggable, spinnable, or throwable with mouse/touch. Use for sliders, cards, reorderable lists, or any drag interaction.

```javascript
gsap.registerPlugin(Draggable, InertiaPlugin);

Draggable.create(".box", { type: "x,y", bounds: "#container", inertia: true });
Draggable.create(".knob", { type: "rotation" });
```

**Full config options:** see [references/dom-ui-plugins.md](references/dom-ui-plugins.md).

### Inertia (InertiaPlugin)

Works with Draggable for momentum after release, or track the inertia/velocity of any property of any object so that it can then seamlessly glide to a stop using a simple tween. Register with Draggable when using `inertia: true`:

```javascript
gsap.registerPlugin(Draggable, InertiaPlugin);
Draggable.create(".box", { type: "x,y", inertia: true });
```

Or track velocity of a property: 
```javascript
InertiaPlugin.track(".box", "x");
```

Then use `"auto"` to continue the current velocity and glide to a stop: 

```javascript
gsap.to(obj, { inertia: { x: "auto" } });
```

### Observer

Normalizes pointer and scroll input across devices. Use for swipe, scroll direction, or custom gesture logic without tying directly to scroll position like ScrollTrigger.

```javascript
gsap.registerPlugin(Observer);

Observer.create({
  target: "#area",
  onUp: () => {},
  onDown: () => {},
  onLeft: () => {},
  onRight: () => {},
  tolerance: 10
});
```

**Full config options:** see [references/dom-ui-plugins.md](references/dom-ui-plugins.md).

## Text

### SplitText

Splits an element’s text into characters, words, and/or lines (each in its own element) for staggered or per-unit animation. Use when animating text character-by-character, word-by-word, or line-by-line. Returns an instance with **chars**, **words**, **lines** (and **masks** when `mask` is set). Restore original markup with **revert()** or let **gsap.context()** revert. Integrates with **gsap.context()**, **matchMedia()**, and **useGSAP()**. API: **SplitText.create(target, vars)** (target = selector, element, or array).

```javascript
gsap.registerPlugin(SplitText);

const split = SplitText.create(".heading", { type: "words, chars" });
gsap.from(split.chars, { opacity: 0, y: 20, stagger: 0.03, duration: 0.4 });
// later: split.revert() or let gsap.context() cleanup revert
```

**Full create() config, onSplit()/autoSplit, tips:** see [references/splittext-deep-dive.md](references/splittext-deep-dive.md).

**Learn more:** [SplitText](https://gsap.com/docs/v3/Plugins/SplitText/)

### ScrambleText

Animates text with a scramble/glitch effect. Use when revealing or transitioning text with a scramble.

```javascript
gsap.registerPlugin(ScrambleTextPlugin);

gsap.to(".text", {
  duration: 1,
  scrambleText: { text: "New message", chars: "01", revealDelay: 0.5 }
});
```

## SVG

### DrawSVG (DrawSVGPlugin)

Reveals or hides the stroke of SVG elements by animating `stroke-dashoffset` / `stroke-dasharray`. Works on `<path>`, `<line>`, `<polyline>`, `<polygon>`, `<rect>`, `<ellipse>`. Use when “drawing” or “erasing” strokes.

**drawSVG value:** Describes the **visible segment** of the stroke along the path (start and end positions), not “animate from A to B over time.” Format: `"start end"` in percent or length. Examples: `"0% 100%"` = full stroke; `"20% 80%"` = stroke only between 20% and 80% (gaps at both ends). The tween animates from the element’s **current** segment to the **target** segment — e.g. `gsap.to("#path", { drawSVG: "0% 100%" })` goes from whatever it is now to full stroke. Single value (e.g. `0`, `"100%"`) means start is 0: `"100%"` is equivalent to `"0% 100%"`. 

**Required:** The element must have a visible stroke — set `stroke` and `stroke-width` in CSS or as SVG attributes; otherwise nothing is drawn.

```javascript
gsap.registerPlugin(DrawSVGPlugin);

// draw from nothing to full stroke
gsap.from("#path", { duration: 1, drawSVG: 0 });
// or explicit segment: from 0–0 to 0–100%
gsap.fromTo("#path", { drawSVG: "0% 0%" }, { drawSVG: "0% 100%", duration: 1 });
// stroke only in the middle (gaps at ends)
gsap.to("#path", { duration: 1, drawSVG: "20% 80%" });
```

**Caveats:** Only affects stroke (not fill). Prefer single-segment `<path>` elements; multi-segment paths can render oddly in some browsers. Contents of `<use>` cannot be visually changed. **DrawSVGPlugin.getLength(element)** and **DrawSVGPlugin.getPosition(element)** return stroke length and current position.

**Learn more:** [DrawSVG](https://gsap.com/docs/v3/Plugins/DrawSVGPlugin)

### MorphSVG (MorphSVGPlugin)

Morphs one SVG shape into another by animating the `d` attribute (path data). Start and end shapes do not need the same number of points — MorphSVG converts to cubic beziers and adds points as needed. Use for icon-to-icon morphs, shape transitions, or path-based animations. Works on `<path>`, `<polyline>`, and `<polygon>`; `<circle>`, `<rect>`, `<ellipse>`, and `<line>` are converted internally or via **MorphSVGPlugin.convertToPath(selector | element)** (replaces the element in the DOM with a `<path>`).

**morphSVG value forms, object config, utilities, tips:** see [references/svg-plugins.md](references/svg-plugins.md).

**Learn more:** [MorphSVG](https://gsap.com/docs/v3/Plugins/MorphSVGPlugin)

### MotionPath (MotionPathPlugin)

Animates an element along an SVG path. Use when moving an object along a path (e.g. a curve or custom route).

```javascript
gsap.registerPlugin(MotionPathPlugin);

gsap.to(".dot", {
  duration: 2,
  motionPath: { path: "#path", align: "#path", alignOrigin: [0.5, 0.5] }
});
```

**Full config (motionPath object):** see [references/svg-plugins.md](references/svg-plugins.md).

### MotionPathHelper

Visual editor for MotionPath (alignment, offset). Use during development to tune path alignment.

```javascript
gsap.registerPlugin(MotionPathPlugin, MotionPathHelperPlugin);

const helper = MotionPathHelper.create(".dot", "#path", { end: 0.5 });
// adjust in UI, then use helper.path or helper.getProgress() in your animation
```

## Easing

### CustomEase

Custom easing curves (cubic-bezier or SVG path). Use when a built-in ease is not enough. Basic usage is covered in gsap-core; register when using:

```javascript
gsap.registerPlugin(CustomEase);
const ease = CustomEase.create("name", ".17,.67,.83,.67");
gsap.to(".el", { x: 100, ease: ease, duration: 1 });
```

### EasePack

Adds more named eases (e.g. SlowMo, RoughEase, ExpoScaleEase). Register and use the ease names in tweens.

### CustomWiggle

Wiggle/shake easing. Use when a value should “wiggle” (multiple oscillations).

### CustomBounce

Bounce-style easing with configurable strength.

## Physics

### Physics2D (Physics2DPlugin)

2D physics (velocity, angle, gravity). Use when animating with simple physics (e.g. projectiles, bouncing).

```javascript
gsap.registerPlugin(Physics2DPlugin);

gsap.to(".ball", {
  duration: 2,
  physics2D: {
    velocity: 250,
    angle: 80,
    gravity: 500
  }
});
```

### PhysicsProps (PhysicsPropsPlugin)

Applies physics to property values. Use for physics-driven property animation.

```javascript
gsap.registerPlugin(PhysicsPropsPlugin);

gsap.to(".obj", {
  duration: 2,
  physicsProps: {
    x: { velocity: 100, end: 300 },
    y: { velocity: -50, acceleration: 200 }
  }
});
```

## Development

### GSDevTools

UI for scrubbing timelines, toggling animations, and debugging. Use during development only; do not ship. Register and create an instance with a timeline reference.

```javascript
gsap.registerPlugin(GSDevTools);
GSDevTools.create({ animation: tl });
```

## Other

### Pixi (PixiPlugin)

Integrates GSAP with PixiJS for animating Pixi display objects. Register when animating Pixi objects with GSAP.

```javascript
gsap.registerPlugin(PixiPlugin);

const sprite = new PIXI.Sprite(texture);
gsap.to(sprite, { pixi: { x: 200, y: 100, scale: 1.5 }, duration: 1 });
```

## Best practices

- ✅ Register every plugin used with **gsap.registerPlugin()** before first use.
- ✅ Use **Flip.getState()** → DOM change → **Flip.from()** for layout transitions; use **Draggable** + **InertiaPlugin** for drag with momentum.
- ✅ Revert plugin instances (e.g. `SplitTextInstance.revert()`) when components unmount or elements are removed.

## Do Not

- ❌ Use a plugin in a tween or API without registering it first (**gsap.registerPlugin()**).
- ❌ Ship GSDevTools or development-only plugins to production.

### Learn More

https://gsap.com/docs/v3/Plugins/

## References

- **references/scroll-plugins.md** — Read when: ScrollToPlugin scrollTo options, or ScrollSmoother setup/DOM structure.
- **references/dom-ui-plugins.md** — Read when: full config tables for Flip (Flip.from vars), Draggable, or Observer.
- **references/splittext-deep-dive.md** — Read when: SplitText full create() config, onSplit()/autoSplit usage, or splitting tips.
- **references/svg-plugins.md** — Read when: MorphSVG value forms/object config/utilities/tips, or MotionPath key config.
