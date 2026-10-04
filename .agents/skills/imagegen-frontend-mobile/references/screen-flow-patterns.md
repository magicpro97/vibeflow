## 7. MULTI-SCREEN CONSISTENCY RULE

If multiple screens are requested, consistency is mandatory.

Keep consistent:
- overall brand mood
- type hierarchy
- palette
- safe-area handling
- navigation behavior
- component family
- surface treatment
- card treatment
- background logic
- image framing
- decorative accents
- device frame presentation

Variation is allowed in:
- composition
- feature emphasis
- image placement
- screen purpose
- visual tempo

But not in:
- product identity
- design system
- mockup quality
- core spacing logic

The flow should feel varied but unified.

---

## 8. LOGICAL FLOW RULE

When multiple images are generated, they must form a believable app flow.

Do not generate random unrelated screens.

The screen order should make sense.

Examples:
- onboarding → auth → home
- home → browse → detail
- profile → settings → edit profile
- cart → checkout → confirmation
- dashboard → activity → detail
- welcome → permissions → personalized home

Ask internally:
- why does screen 2 come after screen 1?
- what action or navigation leads to the next screen?
- is this a believable user journey?
- does the UI state carry forward logically?

A good screen set should feel like a real product walkthrough, not a loose visual collection.

---

## 10. DEVICE MOCKUP FRAME RULE

When using an iPhone, Android, or generic phone mockup, the mockup must look clean and premium.

Rules:
- use one coherent device style across the full set unless the user explicitly wants mixed devices
- keep device scale consistent across all screens in the same series
- keep the mockup centered or aligned with clear discipline
- keep outer spacing around the device clean and balanced
- keep top, bottom, left, and right canvas margins visually even
- do not let the phone touch the canvas edges
- do not use awkwardly cropped device frames
- do not use inconsistent bezels or random frame sizes across screens
- keep shadows soft and controlled
- keep the mockup presentation calm and premium
- the phone border/frame should be visible and clean
- the mockup should support the screen, not overpower it
- keep visual emphasis on the UI content inside the phone

If multiple device mockups appear in one composition:
- keep the same scale
- keep equal gutter spacing between devices
- align them cleanly
- avoid random overlap unless explicitly art-directed

If the concept works better without a visible device frame:
- only then present the screen cleanly with equal outer margins and controlled padding

The presentation should feel:
- neat
- balanced
- premium
- intentional
- content-first

---

## 11. ONBOARDING FLOW RULE

Onboarding should not feel like repeated template slides.

If the user asks for onboarding:
- generate multiple distinct onboarding screens
- vary composition across screens
- vary the balance of image, text, and CTA
- keep the flow coherent
- keep copy short
- keep the first screen especially clean

Good onboarding should feel:
- clear
- fast
- helpful
- visually memorable
- not overexplained

Avoid:
- 3 identical screens with only icon and headline changes
- too much copy
- giant abstract blobs with no product meaning
- fake motivational filler language
- early rating/review prompts
- cluttered first-run screens

---

## 12. FIRST SCREEN CLEANLINESS RULE

The first visible screen matters most.

Whether it is:
- onboarding
- home
- auth
- intro
- welcome
- dashboard

it must feel:
- calm
- premium
- immediately readable
- visually focused

Rules:
- use one primary focal point
- keep the top screen area controlled
- keep the headline short
- do not overload the first viewport
- do not fill it with extra stats, chips, tags, or pills
- do not bury the main CTA
- make the first screen work on a normal phone size without feeling cramped
- if imagery is used behind text, preserve clear readability with fades, masks, or soft scrims

Strong preference:
- 1 to 3 short lines for the main statement
- concise supporting text
- one clear next action

Avoid:
- giant wall of text
- too many micro-labels
- too many overlapping cards
- fake enterprise complexity
- "website hero inside a phone frame"

---

## 13. SAFE AREA AND SYSTEM REGION RULE

Respect mobile screen realities.

Always design with awareness of:
- safe areas
- status bar region
- top bar or title region
- bottom navigation region
- home indicator region
- sheet docking zone
- gesture space

Do not:
- cram important content into unsafe areas
- ignore top and bottom system regions
- make screens feel like edge-to-edge posters with no functional logic
- place critical UI where it would be visually unsafe

Mobile images should feel like real app screens, not posters.

---

## 14. NAVIGATION RULE

Navigation must feel intentional and believable.

Use familiar mobile patterns when appropriate:
- tab bar / bottom navigation for major app sections
- stack navigation feel for drill-down flows
- sheets for secondary tasks
- segmented controls for local switching
- app bars where useful
- clear primary and secondary actions

Do not:
- overload bottom navigation
- hide the main path through the app
- make every action equally important
- create unclear hierarchy between tabs, sheets, and actions

The screen set should imply a believable app flow.
