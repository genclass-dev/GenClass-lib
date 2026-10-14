# Labelling a fresh set of page-element crops

These are the instructions of the Vision v1 fresh test set, unchanged, used again for the Vision v2 fresh dev set.

The labellers are AI agents (Claude subagents), not people. Each pass is a separate agent that sees only its sheets
and this page: no model score or model answer, no other pass's labels, no list of which crops a rule flagged.

## What a sheet shows

Each sheet is a 3 x 3 grid. A cell is a screenshot of part of a real web page: one element and about 24 px around it
(less at the edge of the screen). The element is framed in magenta, just outside its own edges. The caption gives the
cell number, a 6-character code, the device (desktop 1366 x 768, or phone 390 x 844) and the colour scheme the page
was rendered with (light, or dark: the browser asked the page for dark mode). The crop is scaled to fit the cell.

## The question

Would a visitor see a defect in the framed element, as the page shows it now?

- `real`: yes, a visible bug in or of the framed element (see the families below).
- `not`: no, it looks and works as its designer intended. Deliberate design is fine: muted or decorative styling,
  icons without text, images cropped on purpose, carousels, sticky headers, menus that scroll inside themselves,
  an element that simply continues past the screenshot edge or below the fold, a cookie banner that is meant to sit
  on top.
- `unclear`: the crop does not let you decide (too small, cut off in a way that may or may not be the page's fault,
  needs interaction to know).

Judge the framed element only. A bug in a neighbour that merely shows in the context is `not` for this crop, unless
it covers or breaks the framed element. Do not guess what a page "probably" looks like elsewhere.

## Families (only for `real`)

| family | the visible defect |
|---|---|
| `text` | text a visitor should read is unreadable: colour nearly the same as what is behind it, invisible, far too small, garbled, overlapping glyphs |
| `dark` | a dark-mode problem: in a dark-scheme view, colours that do not work (dark text on a dark background, a light block that ignores the theme so text vanishes) |
| `overflow` | content cut off mid-word or mid-control, spilling out of its box, or pushed past the screen edge |
| `responsive` | layout broken at this screen size: squashed, stacked wrongly, far too wide or too narrow for the device |
| `occlusion` | the element is covered or overlapped by another element so it is hard to read or use |
| `media` | an image, icon or video is broken, missing (broken-image icon, empty box with alt text), visibly distorted or squashed, or shows a placeholder |
| `leaks` | template or data leak: lorem ipsum, example contact details, raw `{{variables}}`, code, `undefined`, `null`, `NaN` |
| `blank` | a blank or empty area where content clearly belongs |
| `controls` | a link, button or field that visibly cannot be used: hidden, disabled by mistake, unreachable |
| `other` | another visible defect |

Pick the one family that best names the defect. A dark-scheme view whose text is unreadable is `dark`; the same in a
light view is `text`.

## Output

One CSV line per cell, in the file you were given: `sheet,cell,code,verdict,family,note`. `verdict` is real, not
or unclear; `family` is one of the names above for real and empty otherwise; `note` is at most ten words or empty.
Copy the code exactly as printed. Label every cell.
