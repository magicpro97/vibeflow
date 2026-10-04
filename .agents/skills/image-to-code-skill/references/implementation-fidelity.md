## 26. DESIGN-TO-CODE COPY DISCIPLINE

After generating and analyzing the reference image(s), implement the website in a copy-oriented way.

This means:
- follow the references closely
- preserve layout logic
- preserve spacing rhythm
- preserve section ordering
- preserve text/image balance
- preserve typography mood
- preserve component style
- preserve overall visual cleanliness

Do not drift into a different design direction during implementation.
Do not “improve” the design by replacing it with a generic coded layout.

The goal is not:
- inspired by the image

The goal is:
- visually faithful to the image, translated into real frontend

---

## 27. ANTI-DRIFT IMPLEMENTATION RULE

A common failure mode is design drift:
the generated images look strong, but the coded result becomes generic.

Strictly avoid that.

During implementation:
- do not simplify into default templates
- do not replace distinctive sections with generic rows
- do not compress generous spacing into dense layout
- do not replace strong typography with plain hierarchy
- do not remove the page’s visual identity for convenience
- do not merge section logic into repetitive patterns that were not present in the source images
- do not reintroduce nested-box complexity that was intentionally removed during analysis

The final coded result should still feel like the same website as the generated references.

---

## 28. MISSING DETAIL RESOLUTION

When implementing from images, some details may still be unclear.

Resolve ambiguity by following this order:
1. preserve the visible design language
2. preserve layout and spacing logic
3. preserve component family
4. preserve mood and polish level
5. generate an extra detail image if needed
6. regenerate the section as a fresh standalone image if needed
7. only then choose the most implementation-friendly faithful version

Do not fill ambiguity with generic defaults too quickly.
