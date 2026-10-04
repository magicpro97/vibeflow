# Motion & Animation (Section 5)

## 5. CONTEXT-AWARE PROACTIVITY

These are tools, not defaults. Use them when the design read calls for them. **None of these fire automatically.**

* **Liquid Glass / Glassmorphism:** Appropriate for premium consumer, Apple-adjacent, luxury brand, or media-overlay vibes. Inappropriate for dashboards, public-sector, or "boring B2B." When used, go beyond `backdrop-blur`: add a 1px inner border (`border-white/10`) and a subtle inner shadow (`shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]`) for physical edge refraction. Provide a solid-fill fallback under `prefers-reduced-transparency`.
* **Magnetic Micro-physics:** Use when `MOTION_INTENSITY > 5` AND the brief reads premium / playful / agency. Implement EXCLUSIVELY with Motion's `useMotionValue` / `useTransform` outside the React render cycle. Never `useState`. See Section 3.B.
* **Perpetual Micro-Interactions** (Pulse, Typewriter, Float, Shimmer, Carousel): Use when `MOTION_INTENSITY > 5` AND the section actively benefits from motion (status indicators, live feeds, AI-feel). **Not every card needs an infinite loop.** If a section is informational, leave it still. Apply Spring Physics (`type: "spring", stiffness: 100, damping: 20`) - no linear easing.
* **"Motion claimed, motion shown."** If `MOTION_INTENSITY > 4`, the page must actually move: entry transitions on hero, scroll-reveal on key sections, hover physics on CTAs, at minimum. A static page that claims `MOTION_INTENSITY: 7` is broken. Conversely, if you cannot ship working motion in the available scope, drop the dial to 3 and ship a clean static page. Never half-build motion that breaks (cut-off ScrollTriggers, jumpy enters, missing cleanups).
* **MOTION MUST BE MOTIVATED (mandatory).** Before adding any animation, ask: "what does this animation communicate?" Valid answers: hierarchy (drawing attention to the right thing), storytelling (revealing content in sequence that matches a narrative), feedback (acknowledging a user action), state transition (showing something changed). Invalid answer: "it looked cool". GSAP everywhere because GSAP is available is amateur. Each ScrollTrigger, each marquee, each pinned section needs a reason. If you cannot articulate the reason in one sentence, drop the animation.
* **MARQUEE MAX-ONE-PER-PAGE (mandatory).** Horizontal scrolling text marquees ("logos endlessly scrolling", "manifesto scrolling sideways", "kinetic word strip") are appropriate at most ONCE per page. Two or more marquees on the same page reads as lazy filler. Pick the one section where the marquee actually serves the content; the others get a different layout.
* **GSAP Sticky-Stack Pattern (when scroll-stack is used).** A "card stack on scroll" must be a REAL sticky-stack, not a sequential reveal list. See Section 5.A below for the canonical code skeleton. Common failure: trigger fires halfway through scroll instead of pinning at viewport top. Fix: `start: "top top"` not `start: "top center"` or `"top 80%"`.
* **GSAP Horizontal-Pan Pattern (when horizontal scroll-hijack is used).** See Section 5.B below for the canonical skeleton. Common failure: animation starts before the section is pinned, so the user sees half a slide. Same fix: `start: "top top"`, pin the wrapper, scrub the inner track.

### 5.A Sticky-Stack - Canonical Skeleton

```tsx
"use client";
import { useRef, useEffect } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useReducedMotion } from "motion/react";

gsap.registerPlugin(ScrollTrigger);

export function StickyStack({ cards }: { cards: React.ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !ref.current) return;
    const ctx = gsap.context(() => {
      const cardEls = gsap.utils.toArray<HTMLElement>(".stack-card");
      cardEls.forEach((card, i) => {
        if (i === cardEls.length - 1) return;
        ScrollTrigger.create({
          trigger: card,
          start: "top top",                              // pin at viewport top
          endTrigger: cardEls[cardEls.length - 1],
          end: "top top",
          pin: true,
          pinSpacing: false,
        });
        gsap.to(card, {
          scale: 0.92,
          opacity: 0.55,
          ease: "none",
          scrollTrigger: {
            trigger: cardEls[i + 1],
            start: "top bottom",
            end: "top top",
            scrub: true,
          },
        });
      });
    }, ref);
    return () => ctx.revert();
  }, [reduce]);

  return (
    <div ref={ref} className="relative">
      {cards.map((card, i) => (
        <div
          key={i}
          className="stack-card sticky top-0 min-h-[100dvh] flex items-center justify-center"
        >
          {card}
        </div>
      ))}
    </div>
  );
}
```

Critical points: `start: "top top"`, `pin: true`, every card except the last is pinned, the scale/opacity transform is driven by the NEXT card's scroll trigger (so previous card shrinks as next one arrives).

### 5.B Horizontal-Pan - Canonical Skeleton

```tsx
"use client";
import { useRef, useEffect } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useReducedMotion } from "motion/react";

gsap.registerPlugin(ScrollTrigger);

export function HorizontalPan({ children }: { children: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !wrap.current || !track.current) return;
    const ctx = gsap.context(() => {
      const distance = track.current!.scrollWidth - window.innerWidth;
      gsap.to(track.current, {
        x: -distance,
        ease: "none",
        scrollTrigger: {
          trigger: wrap.current,
          start: "top top",                              // pin starts when section top hits viewport top
          end: () => `+=${distance}`,                    // scroll distance = track width minus viewport
          pin: true,
          scrub: 1,
          invalidateOnRefresh: true,
        },
      });
    }, wrap);
    return () => ctx.revert();
  }, [reduce]);

  return (
    <section ref={wrap} className="relative overflow-hidden">
      <div ref={track} className="flex h-[100dvh] items-center">
        {children}
      </div>
    </section>
  );
}
```

Critical points: `start: "top top"`, `pin: true`, `end: "+=${distance}"` (scroll length = horizontal travel needed), `scrub: 1`. The wrapper is pinned, the inner track slides horizontally as the user scrolls vertically.

### 5.C Scroll-Reveal Stagger - Canonical Skeleton (lighter alternative)

For simple "items appear as they enter viewport" (no pinning), prefer Motion's `whileInView` over GSAP - lighter, no ScrollTrigger needed:

```tsx
"use client";
import { motion, useReducedMotion } from "motion/react";

export function RevealStagger({ items }: { items: string[] }) {
  const reduce = useReducedMotion();
  return (
    <ul className="grid gap-6">
      {items.map((item, i) => (
        <motion.li
          key={item}
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{
            duration: 0.6,
            delay: i * 0.06,
            ease: [0.16, 1, 0.3, 1],
          }}
        >
          {item}
        </motion.li>
      ))}
    </ul>
  );
}
```

Use this for: feature lists, testimonial grids, logo walls, anything that just needs "enter on scroll." Save GSAP for actual pin/scrub work.

### 5.D Forbidden Animation Patterns

* **`window.addEventListener("scroll", ...)`** is banned. It runs on every scroll frame, jank-prone, no batching. Use Motion's `useScroll()`, GSAP's `ScrollTrigger`, IntersectionObserver, or CSS `scroll-driven animations` (`animation-timeline: view()`).
* **Custom scroll progress calculations using `window.scrollY`** in React state. Same reason. Re-renders on every frame.
* **`requestAnimationFrame` loops that touch React state.** Use motion values (`useMotionValue` + `useTransform`) instead.
* **Layout Transitions:** Use Motion's `layout` and `layoutId` props for visible state changes (re-ordering lists, expanding modals, shared elements between routes). Do not wrap static content in `layout` props "for safety" - it costs measurement work.
* **Staggered Orchestration:** Use `staggerChildren` (Motion) or CSS cascade (`animation-delay: calc(var(--index) * 100ms)`) for reveal moments where sequence matters. For `staggerChildren`, parent (`variants`) and children MUST share the same Client Component tree.
