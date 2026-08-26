// Builds the exact same DOM for on-screen editing and for print export -
// there is no separate print layout; @media print in app.css just hides
// the controls (topbar, pickers, layout radios) on this same markup, so
// what you see in the booklet view is what prints.
//
// That parity depends on every ".page" div already being exactly one
// physical sheet's worth of content before it ever reaches the browser's
// print engine - print can only break a page where a ".page" div ends,
// so pagination (deciding which units land on which sheet) has to happen
// here in JS, once, rather than being left to CSS to figure out
// differently on screen vs. in print. See paginateUnits() below.
import {
  CONTENT_WIDTH_MM,
  FILTER_MODES,
  GRID_MM,
  IMAGE_SCALE_MAX,
  IMAGE_SCALE_MIN,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
  PAGE_WIDTH_MM,
  RULE_MM,
  SIZE_PRESETS_MM,
  TIERS,
  canShrink,
  defaultSplitColumnsFor,
  effectiveTierFilter,
  escapeHtml,
  groupIdFor,
  iterRenderUnits,
  passesTierFilter,
  resolvedDefaultScales,
  snapDown,
  splitScaleFor,
} from "./model.js";

const CSS_PX_PER_MM = 96 / 25.4;
// A few mm of slack against sub-pixel measurement/rounding differences
// between this on-screen measurement and the browser's own print layout
// pass - packing right up to the exact edge risks a unit that measured
// as "just fits" rendering a hair taller at print time and spilling onto
// a second sheet anyway.
const PAGE_SAFETY_MARGIN_MM = 3;
const USABLE_HEIGHT_PX = (PAGE_HEIGHT_MM - 2 * PAGE_MARGIN_MM - PAGE_SAFETY_MARGIN_MM) * CSS_PX_PER_MM;
// A landscape sheet for teaching material: the same A4 turned on its
// side, in two columns about A5 wide. A panel is cropped ~150mm wide
// from the book and so never fills the 186mm portrait column - every one
// of them left a 65mm strip of white down the right of the page, and
// there is nothing that can go in it. Turned sideways, two columns of
// them fill the sheet, and Key Ideas, Building Understanding and the
// worked examples stop taking a page each.
const LAND_WIDTH_MM = PAGE_HEIGHT_MM - 2 * PAGE_MARGIN_MM;   // 273
const LAND_HEIGHT_MM = PAGE_WIDTH_MM - 2 * PAGE_MARGIN_MM;   // 186
const LAND_GUTTER_MM = 9;
export const LAND_COL_MM = (LAND_WIDTH_MM - LAND_GUTTER_MM) / 2;
const LAND_COL_PX = (LAND_HEIGHT_MM - PAGE_SAFETY_MARGIN_MM) * CSS_PX_PER_MM;
// The room a teaching item has in a landscape column, in mm.
const LAND_COL_H_MM = LAND_HEIGHT_MM - PAGE_SAFETY_MARGIN_MM;

// How wide each teaching panel prints inside a landscape column.
//
// Full column width wherever it fits - that is the point of turning the
// page, and it is close to the size the book itself sets these at. What
// stops it being that simple is the worked example: question, solution
// and "Now you try" have to end up in ONE column between them, and at
// full width some of them come to more than a column. So an example's
// three panels are measured together, from the true mm size of their
// crops, and if the three overflow they are scaled - all by the same
// factor, or the solution would print a different size from the
// question it answers. Nothing here is a guess at a percentage: it is
// the arithmetic of what fits, which is what makes the same rule work
// on a book whose panels are cropped to a different width.
// What the page costs a panel on top of the panel itself. Left out of
// the sum, an example came to three millimetres more than its column and
// pushed the sheet past A4 - which the export turns into an extra page.
// Both are read off the rendered column rather than guessed at: .block's
// 5px margin-bottom, and the section title's 9.3mm of text between a
// 5.8mm and a 3.2mm margin, which collapse through .heading-unit.
const LAND_PANEL_GAP_MM = 5 / CSS_PX_PER_MM;
// The section title that opens a chapter shares a column with whatever
// panel follows it, so that panel has a title's worth less room than a
// panel further down.
const LAND_TITLE_MM = 19;
function landPanelWidths(workbook) {
  const width = new Map();
  const boxMm = new Map();
  const groups = new Map();
  // Height a group has to fit into: a column, less its panels' margins,
  // less the section title where the group is the one that follows it.
  const room = new Map();
  let afterTitle = false;
  for (const page of workbook.pages) {
    for (const b of page.blocks) {
      if (b.type === "heading" && b.style === "title") {
        afterTitle = true;
        continue;
      }
      if (!b.section || !b.wMm || !b.hMm) continue;
      const key = b.exampleId || b.id;
      if (!groups.has(key)) {
        groups.set(key, []);
        room.set(key, LAND_COL_H_MM - (afterTitle ? LAND_TITLE_MM : 0));
        afterTitle = false;
      }
      groups.get(key).push(b);
    }
  }
  for (const [key, blocks] of groups) {
    // Every panel of the group at column width, plus its own margin.
    const tall = blocks.reduce(
      (h, b) => h + b.hMm * (LAND_COL_MM / b.wMm) + LAND_PANEL_GAP_MM,
      0,
    );
    // A worked example ends in a "Now you try", which is no use without
    // somewhere to answer it - so the smallest box worth having is part
    // of what the group has to fit, not something added afterwards.
    const last = blocks[blocks.length - 1];
    const floor = last.workingSpace ? GRID_MM * 3 : 0;
    const have = room.get(key);
    const scale = Math.min(1, (have - floor) / tall);
    for (const b of blocks) width.set(b.id, LAND_COL_MM * scale);
    // Whatever the column has left over goes to the box - it is the one
    // part of a worked example a student writes in.
    if (last.workingSpace) {
      boxMm.set(last.id, snapDown(Math.max(floor, have - tall * scale), GRID_MM));
    }
  }
  return { width, boxMm };
}
// Below this, a sheet's trailing blank space is just normal slack from
// bin-packing (the next unit genuinely didn't fit) - not worth surfacing
// as an actionable prompt. At or above it, there's room for a real
// "shrink to fit more in" suggestion to make sense of.
const MIN_SQUEEZE_MM = SIZE_PRESETS_MM.small;
const MIN_SQUEEZE_PX = MIN_SQUEEZE_MM * CSS_PX_PER_MM;

// Set once per renderEditor() call, from workbook.buildVersion - see
// its own comment in add_chapter.py for why every crop <img> src needs
// this appended (a rebuilt crop keeps the exact same filename, so
// nothing else would ever tell a browser or CDN the cached bytes under
// that URL just went stale).
let currentBuildVersion = "";
function versionSuffix() {
  return currentBuildVersion ? `?v=${encodeURIComponent(currentBuildVersion)}` : "";
}

let measurerEl = null;
function getMeasurer() {
  if (!measurerEl) {
    measurerEl = document.createElement("div");
    // position:absolute both moves this off-screen and gives it its own
    // block formatting context, so a first/last child's margin renders
    // fully inside the measured box instead of collapsing out through it.
    measurerEl.style.position = "absolute";
    measurerEl.style.visibility = "hidden";
    measurerEl.style.pointerEvents = "none";
    measurerEl.style.left = "-99999px";
    measurerEl.style.top = "0";
    measurerEl.style.width = `${CONTENT_WIDTH_MM}mm`;
    document.body.appendChild(measurerEl);
  }
  return measurerEl;
}

export function waitForImages(container) {
  const imgs = Array.from(container.querySelectorAll("img"));
  return Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          })
    )
  );
}

// Where every question/group sits for the tier odds/evens filters (see
// the filter bar in renderEditor): which chapter and tier heading it
// falls under, and its 1-based position among sibling questions in that
// (chapter, tier) pair. A Fluency group also gets a position *within its
// own group* for each member (a=1, b=2, c=3...) - Fluency's filter
// thins out parts, not whole questions, so that's the number that
// matters there (see the "sub-parts" vs "questions" distinction in the
// filter bar's own label). Has to be a separate up-front pass, not
// something read off a block as it's encountered: a block's position
// can only be known by having already walked everything before it.
export function buildFilterContext(workbook) {
  const chapters = [];
  let chapterId = null;
  let tier = null;
  const tierCounts = {};
  const context = {};
  const partPosition = {};

  for (const page of workbook.pages) {
    for (const b of page.blocks) {
      if (b.type === "heading") {
        if (b.style === "title") {
          chapterId = b.id;
          tier = null;
          if (!/answers$/i.test(b.text || "")) chapters.push({ id: b.id, text: b.text });
        } else if (b.style === "tier" && TIERS.includes(b.tier)) {
          tier = b.tier;
        }
        continue;
      }
      // A text-flow question is one block that carries its own lettered
      // parts inside it (see tools/extract_flow.py), rather than a group
      // of one block per part - so it counts as a single question here,
      // and Fluency's sub-part filter reads positions straight out of
      // b.parts (see flowFilteredBlock) instead of from partPosition.
      if (b.type === "flowquestion") {
        const key = `${chapterId}|${tier}`;
        tierCounts[key] = (tierCounts[key] || 0) + 1;
        context[b.id] = { chapterId, tier, index: tierCounts[key], flow: true };
        continue;
      }
      if (b.type !== "question") continue;
      const gid = groupIdFor(b.id);
      if (gid) {
        if (!context[gid]) {
          const key = `${chapterId}|${tier}`;
          tierCounts[key] = (tierCounts[key] || 0) + 1;
          context[gid] = { chapterId, tier, index: tierCounts[key], partCount: 0 };
        }
        context[gid].partCount += 1;
        partPosition[b.id] = context[gid].partCount;
      } else {
        const key = `${chapterId}|${tier}`;
        tierCounts[key] = (tierCounts[key] || 0) + 1;
        context[b.id] = { chapterId, tier, index: tierCounts[key] };
      }
    }
  }
  return { chapters, context, partPosition };
}

// A group/single question's own whole-question filter (every tier
// except Fluency, whose filter instead thins out parts - see
// buildFilterContext/passesTierFilter in model.js).
function passesWholeQuestionFilter(workbook, ctx) {
  if (!ctx || !ctx.tier || ctx.tier === "fluency") return true;
  const mode = effectiveTierFilter(workbook, ctx.chapterId, ctx.tier);
  return passesTierFilter(mode, ctx.index);
}

// Fluency's filter thins out a question's parts rather than dropping
// whole questions (see the "sub-parts" label in the filter bar). A
// text-flow question holds its own parts, so the thinning happens here,
// on a shallow copy - the block itself is the saved document and must
// not be edited by a render. Returns null when the filter empties a
// question that did have parts: a stem with nothing under it is not
// worth a slot on the page. A question with no parts at all can't be
// thinned, so it passes through untouched, exactly as a standalone
// Fluency question does in the group pipeline.
function flowFilteredBlock(workbook, b, ctx) {
  if (!ctx || ctx.tier !== "fluency") return b;
  const mode = effectiveTierFilter(workbook, ctx.chapterId, "fluency");
  if (mode === "all" || !(b.parts || []).length) return b;
  const parts = b.parts.filter((_p, i) => passesTierFilter(mode, i + 1));
  if (!parts.length) return null;
  if (parts.length === b.parts.length) return b;
  // rowPattern is a hand-set grouping of the rows as they were (see
  // rowColsControlHtml); with parts removed it no longer describes them.
  const { rowPattern, ...rest } = b;
  return { ...rest, parts };
}

// Which members of a group are actually visible, once both the
// automatic tier filter and any explicit per-part/whole-group deletes
// are accounted for. Needed in two places - deciding what to actually
// pass into renderGroup, and (looking one unit ahead) deciding whether
// a stem introducing this group has anything left to introduce - so
// it's centralised here rather than duplicated at each call site.
function groupVisibility(workbook, gid, blocks, filterCtx, deletedIds) {
  const ctx = filterCtx.context[gid] || {};
  // Fluency's filter thins out parts, not whole questions (see the
  // "sub-parts" label in the filter bar) - every other tier is the
  // reverse: a member is never individually auto-hidden, only the group
  // as a whole can be.
  const fluencyMode = ctx.tier === "fluency" ? effectiveTierFilter(workbook, ctx.chapterId, "fluency") : null;
  const memberStatus = blocks.map((mb) => {
    const explicit = deletedIds.has(mb.id);
    const auto = fluencyMode ? !passesTierFilter(fluencyMode, filterCtx.partPosition[mb.id]) : false;
    return { block: mb, explicit, hidden: explicit || auto };
  });
  const visibleMembers = memberStatus.filter((m) => !m.hidden).map((m) => m.block);
  const explicitlyHiddenMembers = memberStatus.filter((m) => m.explicit).map((m) => m.block);
  const wholeGroupExplicitDelete = deletedIds.has(gid);
  const wholeGroupAutoHidden = !fluencyMode && !passesWholeQuestionFilter(workbook, ctx);
  return {
    visibleMembers,
    explicitlyHiddenMembers,
    wholeGroupExplicitDelete,
    wholeGroupAutoHidden,
    fullyHidden: wholeGroupExplicitDelete || wholeGroupAutoHidden || visibleMembers.length === 0,
  };
}

function partLabel(id, gid) {
  return escapeHtml(id.slice(gid.length));
}

function deleteButtonHtml(id, kind, label) {
  return (
    `<button class="delete-btn" data-action="delete" data-target="${escapeHtml(id)}" data-kind="${kind}" ` +
    `title="Delete ${escapeHtml(label)}">✕ ${escapeHtml(label)}</button>`
  );
}

// Opens the manual-crop tool (see crop.js) on whatever's currently
// showing for this one image - a safety valve for the rare automated
// crop that ran too generous, or caught something it shouldn't have.
// Always a single, specific id - never a comma-joined shared target
// like the size/style controls - a crop is inherently a one-image-at-a-
// time operation.
function cropButtonHtml(id, kind) {
  return (
    `<button class="crop-btn" data-action="open-crop" data-target="${escapeHtml(id)}" data-kind="${kind}" ` +
    `title="Manually re-crop this image - in case the automatic crop is too big or caught something it shouldn't have">✂ Crop</button>`
  );
}

// Turns a raw block id - or a comma-joined run of split-part ids, e.g.
// "c10cbu1a,c10cbu1b,c10cbu1c" - into the short label a collapsed
// controls toggle shows, e.g. "BU1a-c". Every question id in this book
// ends with its type ("bu"/"ex"/"nyt"), a number, and (for a split
// part) a single letter - that tail is what actually identifies a
// question to a reader, not the chapter/section code in front of it,
// which is already obvious from where the question sits on the page.
// Falls back to the raw id(s) whenever that pattern doesn't match -
// never worth guessing wrong over just showing the truth, and this
// covers ids (an intro image, a worked example) that were never
// question-shaped to begin with.
function parseQuestionId(id) {
  const m = id.match(/(bu|ex|nyt)(\d+)([a-z])?(?:_stem)?$/i);
  return m ? { type: m[1].toUpperCase(), num: m[2], letter: m[3] || "" } : null;
}

// Strips a leading chapter/section code (e.g. "c10c_", "a3") off an id
// that didn't match parseQuestionId, and title-cases what's left - a
// rough but harmless fallback for the non-question images (intro,
// starter, key ideas, worked examples) that never had a bu/ex/nyt-style
// tail. Returns the id unchanged if stripping would empty it out (an id
// that's ALL chapter-code, with no distinguishing tail of its own,
// isn't safe to guess-shorten).
function humanizeId(id) {
  const stripped = id.replace(/^[a-z]*\d+[a-z]*_?/i, "").replace(/^h_/, "");
  if (!stripped) return id;
  const spaced = stripped.replace(/_/g, " ").replace(/([a-z])(\d)/gi, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function friendlyLabel(idsCsv) {
  const ids = idsCsv.split(",");
  const parsed = ids.map(parseQuestionId);
  if (parsed.every(Boolean)) {
    const first = parsed[0];
    if (parsed.every((p) => p.type === first.type && p.num === first.num)) {
      const letters = parsed.map((p) => p.letter).filter(Boolean);
      let letterPart = "";
      if (letters.length === 1) {
        letterPart = letters[0];
      } else if (letters.length > 1) {
        const contiguous = letters.every((l, i) => i === 0 || l.charCodeAt(0) === letters[i - 1].charCodeAt(0) + 1);
        letterPart = contiguous ? `${letters[0]}-${letters[letters.length - 1]}` : letters.join(",");
      }
      const base = `${first.type}${first.num}${letterPart}`;
      // A question's own leading instruction line (see stem_split in
      // add_chapter.py) shares its parent question's number - "BU1" for
      // both the stem's own crop-scale panel and the group's layout
      // panel, with nothing to tell them apart at a glance. ids.length
      // === 1 is enough to know this is a stem, never a joined split
      // row: stem ids are always singular.
      return ids.length === 1 && /_stem$/.test(ids[0]) ? `${base} stem` : base;
    }
  }
  const extra = ids.length > 1 ? ` +${ids.length - 1}` : "";
  return humanizeId(ids[0]) + extra;
}

// The small always-visible button a collapsed controls panel shows -
// its friendly label is the only thing on screen until clicked; the
// full raw id(s) still live in the title tooltip, so nothing is lost
// for anyone who needs the exact id (debugging, matching a crop file).
// data-action="toggle-controls" (app.js) just flips a CSS class on the
// closest panel - pure DOM/CSS state, no data changed, so it never
// needs to persist or trigger a full re-render.
function collapsibleToggleHtml(label) {
  const safeLabel = escapeHtml(label);
  return (
    `<button type="button" class="controls-toggle" data-action="toggle-controls" data-controls-id="${safeLabel}" title="${safeLabel}">` +
    `${escapeHtml(friendlyLabel(label))}</button>`
  );
}

// Every hanging controls panel opens collapsed, showing only its
// toggle button (see collapsibleToggleHtml) - the full controls
// (innerHtml) are there in the DOM the whole time, just hidden by CSS
// until that button's clicked, so no extra render round-trip is needed
// to expand one. layoutHangingControls() (app.js) nudges a panel down
// whenever a dense run of short questions would otherwise make it
// overlap the one above it, and once nudged, a panel can end up hanging
// next to different content than what it actually belongs to - the
// toggle button's own label is what survives that drift now (it used
// to be a plain "controls-id" tag), so there's always a way to tell
// which crop a given panel is for even when it's no longer sitting
// right beside it.
function controlsHangHtml(label, innerHtml, extraClass = "") {
  return (
    `<div class="controls-hang${extraClass ? " " + extraClass : ""}">` +
    collapsibleToggleHtml(label) +
    `<div class="controls-body">${innerHtml}</div>` +
    `</div>`
  );
}

function restoreListHtml(hiddenMembers, gid) {
  if (!hiddenMembers.length) return "";
  const buttons = hiddenMembers
    .map((b) => `<button data-action="restore" data-target="${escapeHtml(b.id)}">+ ${partLabel(b.id, gid)}</button>`)
    .join("");
  return `<div class="restore-list">${buttons}</div>`;
}

// Stands in for a question/group a user explicitly deleted (see the
// delete buttons above) - deliberately not rendered for one the
// automatic tier filter hid instead: that's meant to disappear cleanly
// (switching the filter back to "all" brings it back), where an
// explicit delete needs its own visible, specific way back.
function deletedPlaceholderHtml(id, label) {
  return (
    `<div class="deleted-placeholder">${escapeHtml(label)} - deleted ` +
    `<button data-action="restore" data-target="${escapeHtml(id)}">+ Restore</button></div>`
  );
}

// Two answer-key page images sharing one row instead of one per row -
// most answer crops are much narrower than a full page (the source PDF
// usually printed them in columns), so a single image per row wasted
// most of the sheet on blank margin either side of it, the same problem
// an unpaired split question part used to have (see renderGroup). Locked
// to one shared size/style control too, same reasoning as a split row's
// matched pair: there's no real reason two crops from the same answer
// key would ever want different sizes.
function buildAnswerRowUnit(a, b) {
  const targets = b ? `${a.id},${b.id}` : a.id;
  const partsHtml = b
    ? `<div class="block">${a.crop}</div><div class="block answer-second">${b.crop}</div>`
    : `<div class="block answer-only">${a.crop}</div>`;
  // Crop, unlike the scale/break-before controls above, is always
  // per-image - each half of the row is its own distinct crop.
  const cropButtons = cropButtonHtml(a.id, "block") + (b ? cropButtonHtml(b.id, "block") : "");
  const hangingControls = controlsHangHtml(targets, imageScaleControlHtml(targets, "block", a.pct) + breakBeforeControlHtml(targets, "block", a.breakBefore) + cropButtons);
  const html = `<div class="answer-row">${partsHtml}${hangingControls}</div>`;
  // a.pct/b.pct are already each image's fully-resolved current scale
  // (own override, if any, else the "answers" default bucket) - passing
  // it straight through as canShrink's fallback default correctly
  // reflects the real current value either way.
  const wsTargets = [{ kind: "block", id: a.id, canShrink: canShrink({}, a.pct) }];
  if (b) wsTargets.push({ kind: "block", id: b.id, canShrink: canShrink({}, b.pct) });
  return { html, heading: false, wsTargets, breakBefore: a.breakBefore || (b ? b.breakBefore : false) };
}

// Only two answer images that end up genuinely adjacent - once every
// logical page in this flush run has already been flattened into one
// list - actually get paired; a heading, a squeeze-in prompt, or any
// other content landing between them (none currently do, but nothing
// here assumes otherwise) naturally leaves both as their own full-width
// row instead of forcing an unrelated pairing.
function pairAnswerImageUnits(units) {
  const merged = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u.answersImage) {
      merged.push(u);
      continue;
    }
    const next = units[i + 1];
    if (next && next.answersImage) {
      merged.push(buildAnswerRowUnit(u.answersImage, next.answersImage));
      i++;
    } else {
      merged.push(buildAnswerRowUnit(u.answersImage, null));
    }
  }
  return merged;
}

// Builds the shared half-width row for two standalone questions paired
// via "Split with next question" (see pairWithNextControlHtml). Unlike
// buildAnswerRowUnit's pair, these two are genuinely unrelated
// questions - each keeps its own full style/size/scale controls, not
// one shared setting - so unlike a split-row's parts (which lock to one
// shared panel because they're truly the same question), both sides'
// full control sets are kept here, just gathered into one panel instead
// of each hanging its own off the page margin: .controls-hang positions
// itself relative to the page, not its own immediate block, so two
// independent hanging panels side by side would both reach for the same
// margin and collide - see the .split-row parts comment above for the
// same reasoning applied to lettered parts.
function buildPairedQuestionRowUnit(a, b) {
  // wsInCrop: a text-flow question renders its own answer space as part
  // of itself - one box per part, or one for the whole question when it
  // has no parts (see flowQuestionHtml) - so adding another here gave
  // every paired flow question a second box underneath the first. On a
  // multi-part question that spare box was also the only one the size
  // controls moved, since the real boxes are the parts' own: the
  // "working space gets split and can't be changed" this used to look
  // like. A bitmap question carries no box of its own and still needs
  // one added.
  const partHtml = (q) =>
    `<div class="block question">${q.crop}${q.wsInCrop ? "" : workingSpaceHtml(q.ws, q.id, "")}</div>`;
  const partsHtml = partHtml(a) + partHtml(b);
  const sideControls = (q, label) =>
    `<div class="paired-side-controls"><span class="paired-side-label">${escapeHtml(label)}</span>` +
    renderQuestionControls(q.id, "block", q.ws, q.pct, q.breakBefore) +
    deleteButtonHtml(q.id, "block", `${label} question`) +
    cropButtonHtml(q.id, "block") +
    `</div>`;
  const unpairBtn =
    `<button class="pair-with-next-toggle active" data-action="toggle-pair-with-next" data-target="${a.id}" data-kind="block">` +
    `✓ Split with next question</button>`;
  const hangingControls = controlsHangHtml(`${a.id},${b.id}`, sideControls(a, "First") + sideControls(b, "Second") + unpairBtn);
  const html = `<div class="split-row cols-2">${partsHtml}${hangingControls}</div>`;
  return {
    html,
    heading: false,
    wsTargets: [
      { kind: "block", id: a.id, canShrink: canShrink({}, a.pct) },
      { kind: "block", id: b.id, canShrink: canShrink({}, b.pct) },
    ],
    breakBefore: a.breakBefore,
  };
}

// Only two standalone questions that end up genuinely adjacent (after
// deletes/filters/answer-pairing have already resolved) get merged -
// same reasoning as pairAnswerImageUnits above. wantsPair only has to
// be true on the *first* of the two: "split with next question" is
// deliberately a one-sided ask (whatever immediately follows, not a
// mutual opt-in from both sides), since the second question shouldn't
// need to also flip its own toggle just to accept.
function pairQuestionUnits(units) {
  const merged = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const next = units[i + 1];
    if (u.pairData && u.pairData.wantsPair && next && next.pairData) {
      merged.push(buildPairedQuestionRowUnit(u.pairData, next.pairData));
      i++;
    } else {
      merged.push(u);
    }
  }
  return merged;
}

// One tier's All/Odds/Evens picker - shared between the workbook-wide
// bar and each chapter's own row, which only differ in what they read
// (global vs a chapter's override) and which id set-tier-filter's click
// handler should write to (data-chapter, omitted for the global bar).
// activeMode is always the *effective* choice (a chapter with no
// override of its own just shows whatever the workbook-wide bar has
// picked) - isOverride only changes the "inherited" styling, not which
// button lights up.
function tierFilterGroupHtml(tier, activeMode, chapterId, isOverride) {
  const label = tier === "fluency" ? `${tier} (sub-parts)` : tier;
  const chapterAttr = chapterId ? ` data-chapter="${escapeHtml(chapterId)}"` : "";
  const buttons = FILTER_MODES.map(
    (mode) =>
      `<button class="${activeMode === mode ? "active" : ""}" data-action="set-tier-filter" ` +
      `data-tier="${tier}"${chapterAttr} data-mode="${mode}">${mode}</button>`
  ).join("");
  const inheritedNote = chapterId && !isOverride ? ' title="Inherited from the workbook-wide filter"' : "";
  return `<div class="tier-filter-group${chapterId && !isOverride ? " inherited" : ""}"${inheritedNote}><span class="tier-filter-label">${escapeHtml(label)}</span>${buttons}</div>`;
}

export function filterBarHtml(workbook, chapterId) {
  const groups = TIERS.map((tier) => {
    const isOverride = !!chapterId && !!workbook.tierFilters?.chapters?.[chapterId]?.[tier];
    const mode = effectiveTierFilter(workbook, chapterId, tier);
    return tierFilterGroupHtml(tier, mode, chapterId, isOverride);
  }).join("");
  const resetBtn = chapterId
    ? `<button class="secondary" data-action="reset-chapter-filter" data-chapter="${escapeHtml(chapterId)}">Use workbook-wide</button>`
    : "";
  return `<div class="${chapterId ? "chapter-filter-bar" : "filter-bar"}">${groups}${resetBtn}</div>`;
}

// A short on-page label for a chapter checkbox/print note - just its
// leading token ("10C" out of "10C Circles, π and circumference"), the
// same short form printed next to each question throughout the book.
function shortChapterLabel(text) {
  return (text || "").split(/\s+/)[0] || text || "";
}

// The "export only some of the book" panel - one checkbox per real
// content chapter (never its own "X Answers" section separately: see
// currentChapterId in renderEditor, one print-selection choice covers a
// chapter and its own answer key together). `selectedIds` is null for
// "everything" (the default - every box starts checked), or a Set of
// chapter ids for whatever the user has actually unchecked down to.
// Purely a print-time filter (see .print-excluded in app.css and
// applyPrintSelection in app.js) - never touches which chapters are
// visible/editable on screen, only which physical sheets survive into
// the printed/exported output.
export function printSelectionBarHtml(workbook, selectedIds, teacherWorkthrough) {
  const { chapters } = buildFilterContext(workbook);
  if (chapters.length < 2) return "";
  const boxes = chapters
    .map((c) => {
      const checked = !selectedIds || selectedIds.has(c.id);
      return (
        `<label class="print-selection-item">` +
        `<input type="checkbox" data-action="toggle-print-chapter" data-chapter="${escapeHtml(c.id)}" ${checked ? "checked" : ""}>` +
        `${escapeHtml(shortChapterLabel(c.text))}</label>`
      );
    })
    .join("");
  return (
    `<div class="filter-bar print-selection-bar">` +
    `<span class="tier-filter-label">Print selection</span>${boxes}` +
    `<button class="secondary" data-action="print-selection-all">All</button>` +
    `<button class="secondary" data-action="print-selection-none">None</button>` +
    teacherWorkthroughToggleHtml(teacherWorkthrough) +
    `</div>`
  );
}

// Off by default: a normal export/print shows every worked example's
// real Solution column exactly as always. Checking this swaps every
// Solution crop for a blank working-space box (see teacherExplanation
// in add_chapter.py / the "workthrough" branch above) for this one
// print/export - Explanation stays showing either way. Purely a print-
// time class on <body> (see applyPrintSelection/toggleTeacherWorkthrough
// in app.js), same as the chapter checkboxes above it - never changes
// the on-screen editing view.
function teacherWorkthroughToggleHtml(enabled) {
  return (
    `<label class="print-selection-item teacher-workthrough-toggle">` +
    `<input type="checkbox" data-action="toggle-teacher-workthrough" ${enabled ? "checked" : ""}>` +
    `Teacher workthrough (blank solutions)</label>`
  );
}

// "Starting point" scales, workbook-wide - a split part, a section
// image, an answers image and a combined/standalone crop each start at a
// different % of their container by default (see DEFAULT_SPLIT_SCALE_2/
// _3/DEFAULT_COMBINED_SCALE in model.js), and this is where that
// starting point itself gets tuned, rather than clicking every
// individual diagram's own +/- control by hand. A block's own +/-
// control still always wins once it's actually been touched (see
// renderQuestionControls et al) - this only ever moves a diagram nobody
// has customized yet. Split gets two independent steppers, not one - a
// 2-up row and a 3-up row need different starting sizes (less width per
// part at 3-up), so one flat "split" default could never fit both.
// Body text size for a text-flow chapter (tools/extract_flow.py) - the
// one control that sets how large EVERY question reads, since flowed
// text is set at a single absolute size rather than inheriting whatever
// scale its crop happened to land on. Only shown for a flow workbook;
// a bitmap chapter has no such single size to set.
export const FLOW_BODY_PT_MIN = 7.5;
export const FLOW_BODY_PT_MAX = 14;
export const FLOW_BODY_PT_STEP = 0.5;
export const DEFAULT_FLOW_BODY_PT = 10.5;

export function flowBodyPt(workbook) {
  return workbook?.flowBodyPt ?? DEFAULT_FLOW_BODY_PT;
}

function flowBodyStepperHtml(workbook) {
  if (!workbook || !workbook.flowVersion) return "";
  const pt = flowBodyPt(workbook);
  return (
    `<div class="tier-filter-group">` +
    `<span class="tier-filter-label">Text size</span>` +
    `<button data-action="step-flow-body" data-delta="-1" ${pt <= FLOW_BODY_PT_MIN ? "disabled" : ""}>−</button>` +
    `<span>${pt}pt</span>` +
    `<button data-action="step-flow-body" data-delta="1" ${pt >= FLOW_BODY_PT_MAX ? "disabled" : ""}>+</button>` +
    `</div>`
  );
}

export function defaultScaleBarHtml(workbook) {
  const scales = resolvedDefaultScales(workbook);
  const stepper = (mode, label, pct) =>
    `<div class="tier-filter-group">` +
    `<span class="tier-filter-label">${escapeHtml(label)}</span>` +
    `<button data-action="step-default-scale" data-mode="${mode}" data-delta="-1" ${pct <= IMAGE_SCALE_MIN ? "disabled" : ""}>−</button>` +
    `<span>${pct}%</span>` +
    `<button data-action="step-default-scale" data-mode="${mode}" data-delta="1" ${pct >= IMAGE_SCALE_MAX ? "disabled" : ""}>+</button>` +
    `</div>`;
  return (
    `<div class="filter-bar default-scale-bar">` +
    flowBodyStepperHtml(workbook) +
    stepper("split2", "Default 2-split scale", scales.split2) +
    stepper("split3", "Default 3-split scale", scales.split3) +
    stepper("section", "Default section scale", scales.section) +
    stepper("answers", "Default answer scale", scales.answers) +
    stepper("combined", "Default combined scale", scales.combined) +
    // Teaching material - Key Ideas, Building Understanding and the
    // worked examples - can print sideways instead, two columns of it to
    // a landscape sheet. Off by default: a panel is cropped too narrow
    // to fill a portrait column, so two columns of them do fit a sheet
    // better, but a section's teaching is only a handful of items and
    // each section has to start a fresh sheet - on this chapter the two
    // effects cancel out almost exactly. It is a look as much as a
    // saving, so it is a switch rather than a decision made here.
    `<div class="tier-filter-group">` +
    `<span class="tier-filter-label">Teaching pages</span>` +
    `<button data-action="toggle-landscape-teaching" class="${workbook.landscapeTeaching ? "active" : ""}">` +
    `${workbook.landscapeTeaching ? "landscape 2-up" : "portrait"}</button>` +
    `</div>` +
    `</div>`
  );
}

// A split row's two diagrams (or an answer row's two answer-key crops -
// see buildAnswerRowUnit) are cropped straight from the source PDF at
// whatever size their printed content happened to need - they rarely
// share a height, so left alone, whichever part's diagram is shorter has
// its working-space grid (or, for an answer row, just its partner) start
// noticeably higher, reading as a mismatched pair rather than one
// aligned row (see .split-row/.answer-row .block-crop in app.css for the
// flex centering this relies on). Called on the same offscreen measurer
// paginateUnits() already loads real images into (see below), before it
// reads any heights - not just a cosmetic patch applied to the visible
// DOM after the fact, which would silently invalidate the sheet-fit
// decision paginateUnits already made from the unstretched heights. The
// visible DOM gets the identical treatment too (see app.js), but only
// because it renders the exact same markup/images/CSS and so always
// computes the exact same numbers - never as the source of truth for
// what fits on a sheet.
// How many screen pixels one of this element's own pixels currently
// takes up. Normally 1; in 100% view mode the page carries a CSS zoom,
// and every getBoundingClientRect() inside it comes back multiplied by
// that. offsetWidth is not zoom-scaled, so the ratio recovers it.
function localScale(el) {
  const own = el.offsetWidth;
  if (!own) return 1;
  const scale = el.getBoundingClientRect().width / own;
  return scale > 0.01 ? scale : 1;
}

// A landscape sheet that came out with only one column in use - always
// a section's last teaching sheet, where what is left over is shorter
// than the worked example that would have filled the fold's other side.
// Nothing else can go there: the exercise that follows is portrait, and
// the next section opens on its own sheet.
//
// So rather than print half a blank side, the trailing "Now you try"
// answer box crosses the fold and takes the whole free column. The
// student reads the example on the left and works on the right, which is
// how a two-page spread is used anyway - and the box goes from the few
// rows the example left it to a full A5 side.
export function spillLandscapeBoxes(container) {
  for (const page of container.querySelectorAll(".page-landscape")) {
    const cols = page.querySelectorAll(".landscape-col");
    if (cols.length !== 1) continue;
    const boxes = cols[0].querySelectorAll(".working-space");
    const box = boxes[boxes.length - 1];
    // Only the last box on the sheet, and only when it closes the sheet:
    // a box with panels under it is somebody's middle, not the leftover.
    if (!box || box.dataset.spilled === "1") continue;
    const free = document.createElement("div");
    free.className = "landscape-col landscape-col-spill";
    page.insertBefore(free, page.querySelector(".page-number"));
    box.dataset.spilled = "1";
    // A ruled box draws its lines as a fixed run of divs laid out for
    // the height it was built at, so simply making it taller would leave
    // the new room blank. The tiled pattern the teacher-workthrough
    // blanks use (see blankSpaceHtml) rules whatever height it is given,
    // which is exactly what a box being resized after layout needs.
    const rules = box.querySelectorAll(".rule-line");
    const step = rules.length ? RULE_MM : GRID_MM;
    if (rules.length) {
      for (const line of rules) line.remove();
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "ws-grid");
      svg.setAttribute("preserveAspectRatio", "none");
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("width", "100%");
      rect.setAttribute("height", "100%");
      rect.setAttribute("fill", `url(#${RULE_PATTERN_ID})`);
      svg.appendChild(rect);
      box.insertBefore(svg, box.firstChild);
    }
    // Height set here rather than left to the column: a box is sized in
    // whole rows of its own ruling everywhere else in the booklet, and a
    // half-row at the bottom edge reads as a mistake.
    box.style.height = `${snapDown(LAND_COL_H_MM, step)}mm`;
    free.appendChild(box);
  }
}

// Gives each wrapped answer box its shape (see wrappedSpaceHtml): the
// rectangle it occupies, minus the corner the diagram beside it takes
// up. How much of the diagram is still to the box's right depends on
// how much of it the question's own text used up, so it can only be
// measured once the text has been laid out. Both edges of the notch
// snap outwards to a whole row and column of the box's own ruling -
// so the box reads as four squares wide, then eight once past the
// diagram, rather than four and a bit.
export function wrapWorkingSpaces(container) {
  for (const box of container.querySelectorAll(".ws-shaped")) {
    const path = box.querySelector(".ws-shape path");
    if (!path) continue;
    const step = (Number(box.dataset.step) || 5) * MM_PX;
    // getBoundingClientRect reports SCREEN pixels, and 100% view mode
    // puts a CSS zoom on the page (see .mode-actual in app.css), so on
    // that setting every measurement here comes back multiplied by the
    // zoom while the coordinates written back are the box's own,
    // unzoomed. Left uncorrected the shape was drawn at 43% of the box
    // it belongs to - on screen AND in the export, since the path is
    // geometry, not a screen style.
    const zoom = localScale(box);
    const r = box.getBoundingClientRect();
    const inset = 0.3 * MM_PX * 0.5; // half the stroke, so it sits inside
    const width = r.width / zoom;
    const height = r.height / zoom;
    const W = width - inset;
    const H = height - inset;
    const float = box.closest(".flowq-body")?.querySelector(".flowq-float");
    let notchW = 0;
    let notchH = 0;
    if (float) {
      const f = float.getBoundingClientRect();
      const style = getComputedStyle(float);
      // The float's MARGIN box is what the text and the diagram are
      // actually kept apart by, so it is what the notch has to clear.
      // The margins come from the computed style, which is already in
      // the element's own pixels - only the measured gaps are scaled.
      const left = (f.left - r.left) / zoom - (parseFloat(style.marginLeft) || 0);
      const bottom = (f.bottom - r.top) / zoom + (parseFloat(style.marginBottom) || 0);
      if (left < width - step && bottom > step) {
        notchW = width - Math.floor(Math.max(0, left) / step) * step;
        notchH = Math.min(Math.ceil(bottom / step) * step, height);
      }
    }
    const x = (W - notchW).toFixed(2);
    const y = notchH.toFixed(2);
    path.setAttribute(
      "d",
      notchW <= 0 || notchH <= 0
        ? `M${inset},${inset} H${W.toFixed(2)} V${H.toFixed(2)} H${inset} Z`
        : notchH >= height
          ? `M${inset},${inset} H${x} V${H.toFixed(2)} H${inset} Z`
          : `M${inset},${inset} H${x} V${y} H${W.toFixed(2)} V${H.toFixed(2)} H${inset} Z`
    );
  }
}

// Sizes each teacher-workthrough blank to the space it is standing in
// for. The blank replaces the worked Solution, so the room it can have
// is whatever that column had - and the Explanation beside it is often
// taller still, in which case the extra is there for free: the row is
// that tall either way, and a bigger box is a better one to work in.
// The split view is print-only and hidden here, so it is shown just
// long enough to measure and put straight back.
export function fitTeacherBlanks(container) {
  for (const split of container.querySelectorAll(".workthrough-split")) {
    const blank = split.querySelector(".teacher-solution-blank");
    const box = blank && blank.querySelector(".working-space");
    if (!box) continue;
    const shown = split.style.display;
    const blankShown = blank.style.display;
    split.style.display = "block";
    blank.style.display = "block";
    box.style.height = "0";
    const zoom = localScale(split);
    const crop = split.querySelector(".teacher-solution-crop");
    const exp = split.querySelector(".workthrough-explanation");
    const combined = split.parentElement.querySelector(".workthrough-combined");
    const height = (el) => (el ? el.getBoundingClientRect().height / zoom : 0);
    // Everything the Solution column had: its own crop, or the
    // Explanation beside it when that is taller, since the row is that
    // tall either way and the extra is free.
    const want = Math.max(height(crop), height(exp));
    // ...but never taller than the combined strip this whole unit
    // stands in for. That strip is what pagination measured (the split
    // is print-only and hidden while it measures), so a blank past it
    // pushes the sheet past its own height and the export spills onto
    // extra pages. The Explanation is a floor - it is there whatever
    // the blank does.
    const cap = Math.max(height(exp), height(combined) - 6);
    const room = Math.min(want, cap);
    split.style.display = shown;
    blank.style.display = blankShown;
    if (room > 10) box.style.height = `${room}px`;
  }
}

export function alignSplitRows(container) {
  for (const row of container.querySelectorAll(".split-row, .answer-row")) {
    const sides = Array.from(row.children).filter((el) => el.classList.contains("block"));
    const crops = sides.map((el) => el.querySelector(".block-crop")).filter(Boolean);
    if (crops.length >= 2) {
      for (const c of crops) c.style.minHeight = "";
      const maxHeight = Math.max(...crops.map((c) => c.getBoundingClientRect().height));
      for (const c of crops) c.style.minHeight = `${maxHeight}px`;
    }
    if (sides.length >= 2) levelRowBottoms(sides);
  }
}

// Two questions sharing a row rarely have the same amount of text above
// their answer boxes, so their boxes stop at different heights and the
// row ends on a ragged step. The space beside the shorter one is dead
// either way - nothing else can be placed in it - so it is given to that
// question's own box instead, and both sides finish level. Only the
// bottom-most boxes on each side grow (a two-column bottom row grows
// both), and the original height is remembered so repeated calls level
// against the real heights rather than compounding.
function levelRowBottoms(sides) {
  const bottomBoxes = (side) => {
    const all = Array.from(side.querySelectorAll(".working-space"));
    if (!all.length) return [];
    for (const box of all) {
      if (box.dataset.baseHeight === undefined) box.dataset.baseHeight = box.style.height || "";
      box.style.height = box.dataset.baseHeight;
    }
    const low = Math.max(...all.map((b) => b.getBoundingClientRect().bottom));
    return all.filter((b) => low - b.getBoundingClientRect().bottom < 1);
  };
  const groups = sides.map(bottomBoxes);
  if (groups.some((g) => !g.length)) return;
  // Screen pixels again (see localScale) - the heights written back are
  // the boxes' own, so the growth has to be converted before it is used.
  const zoom = localScale(sides[0]);
  const boxBottom = groups.map((g) => g[0].getBoundingClientRect().bottom);
  // What sits between the box and the end of its side - normally just
  // the block's own trailing margin, the same on both. If the two sides
  // disagree, one of them has something else below its box; growing
  // that box would push that something down and make the row taller
  // than the height pagination measured, so leave the row alone.
  const gaps = sides.map((s, i) => s.getBoundingClientRect().bottom - boxBottom[i]);
  if (Math.max(...gaps) - Math.min(...gaps) > 4) return;
  const target = Math.max(...boxBottom);
  groups.forEach((boxes, i) => {
    const grow = target - boxBottom[i];
    if (grow < 1) return;
    for (const box of boxes) {
      box.style.height = `${(box.getBoundingClientRect().height + grow) / zoom}px`;
    }
  });
}

// A heading - or a question's shared stem/context image sitting right
// before its first split part - is never worth printing alone at the
// bottom of a sheet with its own content pushed to the next one: find
// how far a "glued bundle" starting at such a unit extends, through any
// run of consecutive headings (an exercise title followed by a tier
// heading, say) plus one more unit beyond them, so the bundle always
// ends on real content. Also stops one unit early whenever the *next*
// unit has a manual "start on a new page" override - that's a
// deliberate, explicit split point, so it has to be able to cut through
// an otherwise-glued chain (a heading gluing forward into what it
// introduces, say) rather than being swallowed into a bundle that never
// lets pagination even consider breaking there.
function bundleEnd(units, i) {
  let j = i;
  while (j < units.length - 1 && units[j].glueForward && !units[j + 1].breakBefore) j++;
  return j;
}

// Packs a logical workbook page's render units into as few physical
// sheets as fit them, in order, never splitting a unit (question/group/
// image/heading) across two sheets - the same atomicity break-inside:
// avoid already gives these in print, just decided up front instead.
// Returns { sheets, leftoverPx }: sheets is an array of sheets, each an
// array of the unit objects on it (almost always a single sheet; more
// only if content overflows one); leftoverPx[i] is how much usable
// height sheet i finished with unused, for the "squeeze in" prompt to
// judge whether a sheet has room worth offering to reclaim.
async function paginateUnits(units, target = {}) {
  const usableHeight = target.usablePx || USABLE_HEIGHT_PX;
  const measurer = getMeasurer();
  // Heights depend on the width the units are laid out at, so a run
  // headed for a narrow landscape column has to be measured in one.
  measurer.style.width = `${target.widthMm || CONTENT_WIDTH_MM}mm`;
  // The repeat headers (see repeatHtml - a shared diagram reprinted at
  // the top of a sheet a question continues onto) are measured in the
  // same pass, tacked on the end: one only costs a sheet anything when
  // its unit actually opens that sheet, so their heights are kept
  // separate and added at packing time rather than baked into the
  // unit's own.
  const repeats = units.filter((u) => u.repeatHtml);
  measurer.innerHTML = units.map((u) => u.html).join("") + repeats.map((u) => u.repeatHtml).join("");
  await waitForImages(measurer);
  wrapWorkingSpaces(measurer);
  fitTeacherBlanks(measurer);
  alignSplitRows(measurer);
  const containerTop = measurer.getBoundingClientRect().top;
  const bottoms = Array.from(measurer.children).map((el) => el.getBoundingClientRect().bottom - containerTop);
  measurer.innerHTML = "";
  const all = bottoms.map((bottom, i) => (i === 0 ? bottom : bottom - bottoms[i - 1]));
  const heights = all.slice(0, units.length);
  repeats.forEach((u, n) => {
    u.repeatHeight = all[units.length + n] || 0;
  });

  const sheets = [[]];
  const sheetHeights = [];
  let sheetHeight = 0;
  // A bundle glued together (see bundleEnd) is never split across
  // sheets, even when it's taller than one page - that's deliberate
  // (see the comment below), but it also means nothing here stops a
  // bundle from growing past USABLE_HEIGHT_PX and printing across a
  // page break that was never meant to exist. Flagged here, where the
  // real per-unit heights already live, purely for app.js to greatly
  // out that bundle's own "+" controls afterwards - unlike everything
  // below, this never changes which sheet anything lands on.
  const oversizedBundle = new Array(units.length).fill(false);
  // Walk whole bundles at a time, not unit by unit - a glued bundle (see
  // bundleEnd) is meant to be atomic, but checking fit again at every
  // unit *inside* an already-placed bundle re-litigates a decision
  // that's already been made: once the bundle's anchor unit has decided
  // it fits (or doesn't, and started a fresh sheet), every later member
  // of that same bundle would independently see "sheet already has
  // content" and re-run its own fit check against just the bundle's
  // remaining tail - which, for a bundle taller than one page, can fail
  // even though the bundle-as-a-whole decision was already correct,
  // splitting the bundle across sheets after all.
  let i = 0;
  while (i < units.length) {
    const bundleLast = units[i].glueForward ? bundleEnd(units, i) : i;
    let bundleHeight = 0;
    for (let k = i; k <= bundleLast; k++) bundleHeight += heights[k];
    if (bundleHeight > usableHeight) {
      for (let k = i; k <= bundleLast; k++) oversizedBundle[k] = true;
    }

    const sheetHasContent = sheets[sheets.length - 1].length > 0;
    // A manual "start on a new page" override always wins, even over a
    // heading directly above it that would otherwise glue forward to it
    // - it's a deliberate, explicit choice for the one case automatic
    // pagination got wrong, not something worth second-guessing. Checked
    // across the whole bundle: the toggle usually lives on the real
    // question at the bundle's tail (its stem is what's glued in front
    // of it), not the anchor unit fit is being decided from.
    let forcedBreak = false;
    for (let k = i; k <= bundleLast && !forcedBreak; k++) forcedBreak = !!units[k].breakBefore;
    forcedBreak = sheetHasContent && forcedBreak;

    if (sheetHasContent && (forcedBreak || sheetHeight + bundleHeight > usableHeight)) {
      sheets.push([]);
      sheetHeights.push(sheetHeight);
      sheetHeight = 0;
    }
    // Opening a sheet is exactly when a continuation gets its question's
    // diagram and wording back (see repeatHtml). It is charged for here,
    // where the sheet it opens is known - the unit is a row or two tall,
    // so the header never turns a fitting sheet into an overflowing one.
    if (!sheets[sheets.length - 1].length && units[i].repeatHtml) {
      units[i].html = units[i].repeatHtml + units[i].html;
      sheetHeight += units[i].repeatHeight || 0;
      units[i].repeatHtml = "";
    }
    for (let k = i; k <= bundleLast; k++) {
      sheets[sheets.length - 1].push(units[k]);
      sheetHeight += heights[k];
    }
    i = bundleLast + 1;
  }
  sheetHeights.push(sheetHeight);

  const leftoverPx = sheetHeights.map((used) => usableHeight - used);
  // heights is by unit, in the order they were passed in - emitLandscape
  // needs them to divide a sheet's worth of units into two columns.
  return { sheets, leftoverPx, oversizedBundle, heights };
}

// Injects a class onto a unit's own top-level element (every unit's html
// starts with exactly this, see the various renderGroup/renderEditor
// branches above) rather than wrapping it in an extra div - a wrapper
// would leave "growth-locked" on a new element one level above whatever
// compactionBundles()/alignSplitRows() (app.js) actually match against
// (.heading-unit, .split-row, [data-glue-example], ...), breaking every
// selector that assumes a unit's own element is still the direct child
// of .page.
function markGrowthLocked(html) {
  return html.replace('<div class="', '<div class="growth-locked ');
}

// widthMm is a fixed size set at content-authoring time (add_chapter.py -
// used for a handful of explicitly-sized answer images); imageScale is
// the user's own runtime "shrink the diagram" choice, a percentage of
// the container. widthMm wins when both are present - it's deliberate
// and rare enough that a runtime scale on top of it would be surprising.
function cropHtml(cropsBaseUrl, crop, contextImage, widthMm, imageScale, manualCropSrc) {
  let contextHtml = "";
  if (contextImage) {
    contextHtml = `<img src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(contextImage)}.png${versionSuffix()}">`;
  }
  let style = "";
  if (widthMm) style = ` style="width:${widthMm}mm"`;
  else if (imageScale && imageScale !== 100) style = ` style="width:${imageScale}%"`;
  // A manually re-cropped PNG (see crop.js) - a data: URL standing in
  // for the original file, so there's no server-side URL to ever go
  // stale in a cache - versionSuffix() only matters for the plain
  // server-file path below. Everything downstream (pagination
  // measurement, the diagram-scale control, print export) just sees
  // another <img src>, no special-casing needed anywhere else.
  const src = manualCropSrc ? escapeHtml(manualCropSrc) : `${escapeHtml(cropsBaseUrl)}/${escapeHtml(crop)}.png${versionSuffix()}`;
  return `<div class="block-crop"${style}>${contextHtml}<img src="${src}"></div>`;
}

// The source book sets its body at 10pt, so every mm measurement the
// extractor recorded is relative to that. Dividing by 10pt-in-mm turns
// those into `em`, which is what makes an inline math fragment scale
// with the body text automatically: change the workbook's font size and
// the fractions follow, with no re-cropping and no second scale to keep
// in sync.
const PT10_MM = 10 * 25.4 / 72;

function flowRunsHtml(runs, cropsBaseUrl) {
  return (runs || [])
    .map((r) => {
      if (r.t !== undefined) {
        const t = escapeHtml(r.t);
        return r.i ? `<i>${t}</i>` : t;
      }
      // A 2D-layout fragment (fraction, superscript) spliced back into
      // the line. Height in em keeps it the same visual size as the
      // words around it; the negative vertical-align is how far its
      // bottom sits below the baseline, so a denominator hangs and a
      // superscript rides high instead of both sitting on the line.
      const hEm = (r.hMm / PT10_MM).toFixed(3);
      const dropEm = ((r.dropMm || 0) / PT10_MM).toFixed(3);
      return (
        `<img class="imath" src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(r.m)}.png${versionSuffix()}" ` +
        `style="height:${hEm}em;vertical-align:${-dropEm}em" alt="">`
      );
    })
    .join("");
}

// How many parts to set across the page.
//
// The book itself varies this - three ratio triangles go across in a
// row, sixteen small ones go four across - and matching it is what
// keeps a grid looking typeset rather than arbitrary. The widest
// diagram in the grid decides the ceiling, since every column has to
// hold the widest one without squeezing it; the part count then keeps
// short grids from being split into silly little columns.
function flowGridColumns(parts, figH, sourceCols) {
  // Width AFTER the height snap, not the figure's own width - a figure
  // scaled to a common height is not the width it was cropped at, and
  // sizing columns on the raw width overflows the row.
  const widest = parts.reduce(
    (m, p) =>
      Math.max(
        m,
        ...(p.figures || []).map((f) => (figH && f.hMm ? (f.wMm * figH) / f.hMm : f.wMm)),
        0
      ),
    0
  );
  // Usable content width is ~170mm; leave a gutter between columns.
  const byWidth = widest > 0 ? Math.floor(170 / (widest + 6)) : 4;
  // The book's own count leads, since it is a typesetter's decision
  // about this particular grid rather than a rule. It is still capped
  // by what actually fits: these pages are narrower than the source's,
  // so a source column count is a preference, not a guarantee. A
  // source count of ONE is a real decision too - a question whose
  // parts are prose sets them down the page, and pairing them into
  // columns is what made a three-part question read a, b / c.
  const byCount = sourceCols >= 1 ? sourceCols : parts.length >= 9 ? 4 : parts.length >= 5 ? 3 : 2;
  return Math.max(1, Math.min(4, byWidth, byCount));
}

// The only diagram heights this book uses. Snapping every figure to
// one of them is what stops the page looking sporadic: the source
// crops run from 9mm to 98mm tall in arbitrary increments, and printed
// at their true sizes no two diagrams ever quite agree. Five steps is
// enough to keep a thumbnail small and a detailed diagram legible,
// while being few enough that the eye reads them as a set.
const FIG_HEIGHTS_MM = [16, 22, 28, 34, 40];

// One height for all the figures in a question, chosen from the median
// of their true heights. Median rather than max, so a single oversized
// diagram cannot inflate the whole row; and one value for the whole
// question, so its diagrams line up with each other rather than each
// being independently correct and collectively ragged.
function figureHeightMm(figs, figPct) {
  const hs = figs.map((f) => (f.hMm * figPct) / 100).filter((h) => h > 0).sort((a, b) => a - b);
  if (!hs.length) return null;
  const med = hs[Math.floor(hs.length / 2)];
  return FIG_HEIGHTS_MM.reduce((best, h) => (Math.abs(h - med) < Math.abs(best - med) ? h : best));
}

// Splits a question's parts into the rows its grid will actually set
// them in, so a tall grid can paginate a row at a time instead of
// jumping to the next page whole. A sixteen-triangle question is
// taller than the space left under the question above it far more
// often than not, and as one atomic unit it left half a page empty
// every time.
// A question whose parts are set beside a shared diagram is never
// split: the whole point of that layout is that the parts sit next to
// the picture they are read against, and a row on its own on the next
// page would have neither the picture nor anything to say why.
// How many sub-items to set across. The book's own count leads, since
// it already judged how wide each item is: four bare angles go four
// across, four "sin 28 and cos 62" pairs go two. It is then capped by
// how much width this part actually has - a part inside a two-column
// part grid has half a page, not a whole one.
function subCols(p, partCols) {
  const want = p.subColumns || 1;
  const room = partCols >= 3 ? 1 : partCols === 2 ? 2 : 4;
  return Math.max(1, Math.min(want, room));
}

// A part floats its own diagram when it has other content to wrap
// around it - sub-items, or prose of its own. A bare diagram-and-box
// part is a grid cell and keeps its diagram above the box.
// A floated diagram is sized in mm, from its own printed width. Left to
// its intrinsic pixel size it renders at the crop's 3x zoom - about
// twice its true size - and overflows the column it is floating in.
function floatMm(f, figPct) {
  return Math.max(30, Math.min(72, (f.wMm * figPct) / 100)).toFixed(0);
}

// The per-row layout control: a small chip on each row of a part grid
// showing how many parts are on it, which cycles 1 - 2 - 3 - 4 on
// click. Editor-only (hidden in print, like every other control), and
// it is the only way to say something the build cannot work out for
// itself: whether THIS row should be narrow because a diagram is
// beside it, or wide because the space below one is now free.
// What this row's column button can actually do. Every candidate is
// laid out and compared against the layout on screen, and only the ones
// that come out different are offered - so a press always moves
// something. Without that the button had settings that were no-ops:
// asking a row for one part when it already holds one, or asking the
// LAST row for more when there is nothing after it to pull up. Those
// presses lit the button up and changed nothing, which is what made the
// control feel broken on 3E Q2 and every other question ending in a
// single-part row. A row with no useful setting at all gets no button.
export function rowColsCycle(b, figPct, rowIndex) {
  const rows = flowQuestionRows(b, figPct);
  if (rowIndex >= rows.length) return null;
  const saved = Array.isArray(b.rowPattern) ? b.rowPattern : [];
  const base = saved.slice(0, rowIndex);
  const shapeOf = (value) =>
    flowQuestionRows({ ...b, rowPattern: value === 0 ? base : base.concat([value]) }, figPct)
      .map((r) => r.parts.length)
      .join(",");
  // Never more columns than there are parts left to fill them.
  const left = rows.slice(rowIndex).reduce((n, r) => n + r.parts.length, 0);
  const current = rows[rowIndex].set ? saved[rowIndex] | 0 : 0;
  const here = shapeOf(current);
  // 1..max, then automatic to close the cycle.
  const order = [];
  for (let n = 1; n <= Math.min(4, left); n++) order.push(n);
  order.push(0);
  const from = order.indexOf(current);
  for (let i = 1; i <= order.length; i++) {
    const candidate = order[(from + i + order.length) % order.length];
    if (shapeOf(candidate) !== here) {
      return { current, next: candidate, label: current || rows[rowIndex].parts.length };
    }
  }
  return null;
}

function rowColsControlHtml(blockId, rowIndex, count, pinned) {
  return (
    `<button class="row-cols${pinned ? " row-cols-set" : ""}" data-action="set-row-cols" ` +
    `data-target="${escapeHtml(blockId)}" data-row="${rowIndex}" data-set="${pinned ? 1 : 0}" ` +
    `title="${pinned ? "Parts on this row (set by hand)" : "Parts on this row (automatic)"}` +
    ` - click to change">${count}</button>`
  );
}

function partFloats(p) {
  if ((p.figures || []).length !== 1) return false;
  return (p.subs || []).length > 0;
}

function sharedFigOn(b) {
  return (b.parts || []).length > 0 && (b.figures || []).length === 1;
}

// The automatic column count for a question's part grid. Shared by the
// renderer and by flowQuestionRows so the two cannot disagree: when
// they did, a question whose parts are narrowed to sit beside a
// diagram still had its ROWS grouped by the book's full-width count,
// and three ratio boxes ended up squeezed into the strip left over
// next to a photograph.
function flowColsFor(b, figPct) {
  const parts = b.parts || [];
  if (!parts.length) return 0;
  if (sharedFigOn(b)) return parts.length > 4 ? 2 : 1;
  const figH = figureHeightMm(parts.flatMap((p) => p.figures || []), figPct);
  return flowGridColumns(parts, figH, b.columns || 0);
}

// A part whose sub-items are stacked one per line can be broken between
// them - each sub-item is its own instruction and its own answer box, so
// "a i" at the foot of a sheet and "a ii" at the top of the next reads
// exactly as it should. That is the finest split a question has, and
// without it a question like 3E Q2 - whose every part is three stacked
// sub-items - could only ever move a whole part at a time, which is
// what left the bottom 40% of a sheet empty.
export function splitPartRows(row) {
  if (row.parts.length !== 1) return [row];
  const part = row.parts[0];
  const subs = part.subs || [];
  if (subs.length < 2 || subCols(part, row.cols) !== 1) return [row];
  return subs.map((sub, i) => ({
    ...row,
    parts: [i === 0 ? { ...part, subs: [sub] } : { ...part, subs: [sub], contd: true }],
  }));
}

export function flowQuestionRows(b, figPct) {
  const parts = b.parts || [];
  if (!parts.length) return [];
  const cols = flowColsFor(b, figPct);
  const rows = [];
  // A saved pattern says how many parts sit on each row - [1, 2, 2]
  // rather than the even 2, 2, 1 the column count alone would give.
  // It is read as far as it goes and the rest falls back to the even
  // split, so a pattern stays usable if the question later gains parts.
  const pattern = Array.isArray(b.rowPattern) ? b.rowPattern : [];
  let i = 0;
  for (const n of pattern) {
    if (i >= parts.length) break;
    const take = Math.max(1, Math.min(4, n | 0));
    // A row the pattern set uses exactly that many columns, so asking
    // for one part on a row really does give it the full width. A row
    // that fell through to the even split keeps the question's own
    // column count, so a lone part at the end of a 2-wide grid still
    // sits in a 2-wide column rather than stretching across the page.
    rows.push({ parts: parts.slice(i, i + take), cols: take, set: true });
    i += take;
  }
  for (; i < parts.length; i += cols) {
    rows.push({ parts: parts.slice(i, i + cols), cols, set: false });
  }
  return rows;
}

function flowQuestionHtml(b, cropsBaseUrl, ws, figPct, slice) {
  // Each part carries its own answer box, sized at build time from what
  // that part actually asks (see assign_working_space). A part that
  // says "explain why" gets ruled lines while its neighbour that says
  // "find x" gets squares, which one box for the whole question can
  // never do. The 90%-of-the-question fallback is only for older
  // chapters built before parts carried their own.
  const fallbackWs = {
    style: ws.style,
    heightMm: Math.max(GRID_MM * 3, Math.round((ws.heightMm || 15) * 0.9)),
  };
  // A box someone has resized by hand wins over the one the build
  // measured for that part (see step-part-height in app.js).
  const sized = b.partSpaces || {};
  const wsFor = (p) => sized[p.letter] || p.workingSpace || fallbackWs;
  const subWsFor = (p, sub) => sized[`${p.letter}.${sub.letter}`] || sub.workingSpace;
  const stem = (b.stem || []).length ? `<p class="flowq-stem">${flowRunsHtml(b.stem, cropsBaseUrl)}</p>` : "";
  // Every part is a real cell - letter, its text, its diagram, and its
  // own answer box. Parts without diagrams are cells too: they are
  // still separate questions to be answered separately, and a single
  // shared box underneath gives a student nowhere to put the working
  // for part (g) that is recognisably part (g)'s.
  const partsHaveFigs = (b.parts || []).some((p) => (p.figures || []).length);
  const partFigList = (b.parts || []).flatMap((p) => p.figures || []);
  const partFigH = figureHeightMm(partFigList, figPct);
  const partFig = (p) =>
    (p.figures || [])
      .map(
        (f) =>
          `<img class="flowq-fig" src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(f.crop)}.png${versionSuffix()}" ` +
          `style="height:${partFigH}mm" alt="">`
      )
      .join("");
  // One diagram serving several parts is set BESIDE them, not above:
  // the diagram on the right, the parts and their answer boxes down
  // the left. That is how the page reads - you look at the picture
  // once and work down the list against it - and it recovers the
  // whole right-hand half of the page, which a full-width diagram
  // with the parts underneath simply leaves empty.
  const sharedFig = (b.parts || []).length > 0 && (b.figures || []).length === 1;
  // Beside a floated diagram the parts have about half the page, so
  // they stack rather than trying to hold the book's own column count
  // - see flowColsFor, which flowQuestionRows uses too so the rows are
  // grouped by the same number they are laid out in.
  const cols = flowColsFor(b, figPct);
  // A slice renders only some of the parts, so a tall grid can be split
  // over a page break. `head` carries the number, stem and shared
  // diagrams; the rest carry grid rows only.
  const head = !slice || slice.head;
  // Beside a float the parts are plain blocks, not a grid. A grid
  // container establishes its own formatting context, so it would
  // shorten beside the diagram and STAY short for its whole height -
  // holding the dead space open under a short diagram, which is the
  // thing the float is meant to reclaim.
  // One grid PER ROW, so rows can differ in width. An even split is
  // only ever a guess at where the diagrams fall; the person looking at
  // the page can see that 1, 2, 2 fits where 2, 2, 1 does not, and
  // rowPattern is how they say so (see rowColsControlHtml).
  const rowsFor = slice ? (slice.row ? [slice.row] : []) : flowQuestionRows(b, figPct);
  // p.contd marks the tail of a part that has been split between its own
  // sub-items (see splitPartRows): the letter and the wording are on the
  // piece before it, and repeating them would read as a second part (a).
  // The empty letter column keeps the sub-items on the same indent they
  // had on the page before.
  const cellHtml = (p) =>
            `<div class="flowq-cell">` +
            (p.contd
              ? `<div class="flowq-cell-head"><span class="flowq-letter"></span></div>`
              : `<div class="flowq-cell-head"><span class="flowq-letter">${escapeHtml(p.letter)}</span>` +
                `<span class="flowq-ptext">${flowRunsHtml(p.content, cropsBaseUrl)}</span></div>`) +
            // The part's own diagram comes BEFORE its sub-items: it is
            // what they are answered against, so printing it after
            // them left it stranded under a column of answer boxes
            // with nothing to say which question it belonged to.
            //
            // A part that has BOTH a diagram and sub-items floats the
            // diagram right, so its sub-items and their boxes wrap
            // beside it, exactly as a shared diagram does. A part with
            // a diagram and nothing else keeps the diagram above its
            // box, centred - that is the grid case, and floating there
            // would break the rows' alignment.
            (!p.contd && (p.figures || []).length
              ? partFloats(p)
                ? `<div class="flowq-float flowq-part-float" style="width:${floatMm(p.figures[0], figPct)}mm">` +
                  `<img class="flowq-fig" src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(p.figures[0].crop)}.png${versionSuffix()}" ` +
                  `style="width:100%;height:auto" alt=""></div>`
                : `<div class="flowq-cell-fig">${partFig(p)}</div>`
              : "") +
            // Roman sub-items keep their own line and their own marker,
            // as the book sets them. Run together into the part's own
            // sentence they read as one impossible instruction.
            ((p.subs || []).length
              ? `<div class="flowq-subs" style="grid-template-columns:repeat(${subCols(p, cols)},1fr)">` +
                p.subs
                  .map(
                    (s) =>
                      `<div class="flowq-sub-cell">` +
                      `<div class="flowq-sub"><span class="flowq-subletter">${escapeHtml(s.letter)}</span>` +
                      `<span class="flowq-ptext">${flowRunsHtml(s.content, cropsBaseUrl)}</span></div>` +
                      (s.workingSpace ? workingSpaceHtml(subWsFor(p, s), b.id, `${p.letter}.${s.letter}`) : "") +
                      `</div>`
                  )
                  .join("") +
                `</div>`
              : "") +
            workingSpaceHtml(wsFor(p), b.id, p.letter) +
            `</div>`;
  // No button on a row that cannot change, and none on the tail of a row
  // split between its sub-items - the button belongs to the row, and the
  // row starts on the piece before.
  const rowControlHtml = (index, suppressed) => {
    if (suppressed) return "";
    const cycle = rowColsCycle(b, figPct, index);
    if (!cycle) return "";
    return rowColsControlHtml(b.id, index, cycle.label, cycle.current !== 0);
  };
  const parts = rowsFor.length
    ? rowsFor
        .map(
          (row, ri) =>
            `<div class="flowq-grid${sharedFig ? " flowq-flow" : ""}" ` +
            `style="grid-template-columns:repeat(${row.cols},1fr)">` +
            row.parts.map(cellHtml).join("") +
            rowControlHtml((slice ? slice.rowIndex : 0) + ri, slice && slice.noRowControl) +
            `</div>`
        )
        .join("")
    : "";
  // Figures are the only thing here that scales. They carry their true
  // mm size from the PDF, so the percentage is a real proportion of the
  // printed original rather than of whatever container they land in.
  const ownFigH = figureHeightMm(b.figures || [], figPct);
  const figs = (b.figures || [])
    .map((f) =>
      // Beside the parts a diagram is sized by WIDTH, so it fills its
      // column; on its own it keeps the shared standard height.
      sharedFig
        ? `<img class="flowq-fig" src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(f.crop)}.png${versionSuffix()}" ` +
          `style="width:100%;height:auto;max-height:95mm" alt="">`
        : `<img class="flowq-fig" src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(f.crop)}.png${versionSuffix()}" ` +
          `style="height:${ownFigH}mm" alt="">`
    )
    .join("");
  // One figure sits beside the text (a photo alongside a short
  // question, as the book prints it); several go in a wrapping row
  // below it. Stacking a set of four diagrams down a narrow side
  // column is what the source never does and what makes them run a
  // whole page tall - across is both denser and closer to the original.
  const many = (b.figures || []).length > 1;
  const figBlock = figs ? `<div class="flowq-figs${many ? " flowq-figs-row" : ""}">${figs}</div>` : "";
  // A question-level figure on a question that HAS parts is shared
  // context - "here are two similar triangles A and B" - which every
  // part then refers to. It has to come before them: printed after,
  // the diagrams landed at the foot of the question, below all the
  // answer boxes that depend on reading them.
  const contextFig = (b.parts || []).length ? figBlock : "";
  // Diagram right, parts left. The figure column is sized from the
  // diagram's own printed width so a small triangle does not claim
  // half the page, and clamped so a wide photograph does not crowd
  // the answer boxes out.
  // A question with no parts and one diagram gets the same treatment:
  // the diagram floats right of its own text, and the answer box wraps
  // around it - narrow while it is level with the diagram, full width
  // below. Set in a reserved side column instead (which is what this
  // used to do), the box could only start under BOTH the text and the
  // diagram, so the strip beside a photograph was dead space on every
  // worded question in the chapter.
  const soloFloat = !(b.parts || []).length && (b.figures || []).length === 1;
  const figMm =
    sharedFig || soloFloat
      ? Math.max(38, Math.min(78, (b.figures[0].wMm * figPct) / 100))
      : 0;
  // The diagram FLOATS right rather than sitting in a reserved column.
  // Every answer box establishes its own formatting context (it has to,
  // to clip its grid lines), so each one shortens to clear the float
  // while it is beside the diagram and takes the full width again once
  // past it. That is what a reserved column cannot do: it holds the
  // dead space under a short diagram open for the whole question.
  const splitHtml = () =>
    (head ? `<div class="flowq-float" style="width:${figMm.toFixed(0)}mm">${figBlock}</div>` : "") +
    parts;
  const floatHtml = `<div class="flowq-float" style="width:${figMm.toFixed(0)}mm">${figBlock}</div>`;
  // The answer space sits OUTSIDE the row, so it spans the full content
  // width for every question. Inside the row it inherited whatever was
  // left after the figure column, so a question with a photo beside it
  // got a visibly narrower grid than the one above - the ragged,
  // stepped look of a page of mixed questions.
  return (
    `<div class="flowq-unit">` +
    `<div class="flowq-row">` +
    `<div class="flowq-num">${head ? escapeHtml(b.number || "") : ""}` +
    (slice && slice.repeat ? `<span class="flowq-cont-tag">cont.</span>` : "") +
    `</div>` +
    `<div class="flowq-body">` +
    (head && soloFloat ? floatHtml : "") +
    (head ? stem : "") +
    (sharedFig ? splitHtml() : (head ? contextFig : "") + parts) +
    (head && !contextFig && !soloFloat && many ? figBlock : "") +
    // A wrapped box has to be INSIDE the body, beside the float; every
    // other box stays outside the row, where it spans the full content
    // width whatever the question above it looked like.
    (head && soloFloat ? wrappedSpaceHtml(ws, b.id, "") : "") +
    `</div>` +
    (head && !contextFig && !soloFloat && !many ? figBlock : "") +
    `</div>` +
    // Parts bring their own boxes, so the whole-question box is only
    // for a question that has no parts at all - otherwise every
    // multi-part question ended with a second, unusable spare box.
    (head && !(b.parts || []).length && !soloFloat ? workingSpaceHtml(ws, b.id, "") : "") +
    `</div>`
  );
}

// Alignment hint carried from build time (content_kind in
// add_chapter.py) - see the .block-crop rules in app.css. Absent means
// text, the common case.
function kindAttr(b) {
  return b && b.contentKind === "diagram" ? ' data-kind="diagram"' : "";
}

function ruleLinesHtml(height, spacing) {
  let inner = "";
  for (let y = spacing; y < height; y += spacing) {
    inner += `<div class="rule-line" style="top:${y}mm"></div>`;
  }
  return inner;
}

// The 5mm squares are one SVG tile pattern stretched over the box, not
// a fixed run of absolutely positioned line divs. A box's height is
// known here (it's set right below), but its width is not: a
// .working-space is width:auto so it can shrink beside a diagram float
// and take the full width again once clear of it. Emitting a fixed
// BOX_WIDTH_MM worth of vertical line divs meant every narrowed box had
// lines running a hundred-odd mm past the page edge - invisible on
// screen (overflow:hidden clips them) but not to print, where Chromium
// measures the overflowing layout and shrink-to-fits the ENTIRE document
// to fit the sheet. One narrow grid box was enough to print all 49 pages
// at ~66% in the corner of an A4. A rect filled at 100%/100% of its own
// box can't overflow by construction, at any width the box resolves to.
// SVG rather than a repeating-linear-gradient background: Chromium
// rasterizes gradient tiles into the exported PDF (they come out blurry
// and misaligned at print resolution), but keeps SVG as vector.
const GRID_PATTERN_ID = "ws-grid-5mm";
const RULE_PATTERN_ID = "ws-rule-10mm";
export const MM_PX = 96 / 25.4;

function gridPatternDefs() {
  const step = GRID_MM * MM_PX;
  const rule = RULE_MM * MM_PX;
  const w = 0.5 * MM_PX;
  const off = (step - w).toFixed(3);
  return (
    `<svg class="ws-grid-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>` +
    `<pattern id="${GRID_PATTERN_ID}" width="${step.toFixed(3)}" height="${step.toFixed(3)}" patternUnits="userSpaceOnUse">` +
    `<rect x="${off}" y="0" width="${w.toFixed(3)}" height="${step.toFixed(3)}" fill="#ccc"></rect>` +
    `<rect x="0" y="${off}" width="${step.toFixed(3)}" height="${w.toFixed(3)}" fill="#ccc"></rect>` +
    `</pattern>` +
    // Ruled lines for a written-response box, as a pattern too, so a
    // wrapped one is filled by the same single shape as a squared one.
    `<pattern id="${RULE_PATTERN_ID}" width="${rule.toFixed(3)}" height="${rule.toFixed(3)}" patternUnits="userSpaceOnUse">` +
    `<rect x="0" y="${(rule - w).toFixed(3)}" width="${rule.toFixed(3)}" height="${w.toFixed(3)}" fill="#bbb"></rect>` +
    `</pattern>` +
    `</defs></svg>`
  );
}

function gridBoxHtml(height, grip) {
  return (
    `<div class="working-space" style="height:${height}mm">` +
    `<svg class="ws-grid" preserveAspectRatio="none"><rect width="100%" height="100%" fill="url(#${GRID_PATTERN_ID})"></rect></svg>` +
    grip +
    `</div>`
  );
}

// Taller/shorter for one box, sitting in its own corner. Every answer
// box on the page has a pair, whatever kind of block it belongs to:
// reaching for the box you want to change is the obvious move, and on a
// question whose parts each own a box (see assign_working_space in
// tools/extract_flow.py) the size control in the hanging panel has
// nothing to move anyway. `key` names one part's box ("a", or "a.i" for
// a sub-item's); empty means the block's or group's own box, which the
// same step-height action the hanging panel uses already knows how to
// resize.
function boxGripHtml(target, key, kind = "block", spacing = GRID_MM) {
  if (!target) return "";
  const t = escapeHtml(target);
  const attrs = key
    ? (d) => `data-action="step-part-height" data-target="${t}" data-part="${escapeHtml(key)}" data-delta="${d}"`
    : (d) => `data-action="step-height" data-target="${t}" data-kind="${kind}" data-spacing="${spacing}" data-delta="${d}"`;
  const btn = (d, label, title) => `<button ${attrs(d)} title="${title}">${label}</button>`;
  return `<span class="ws-grip">${btn(-1, "−", "Shorter")}${btn(1, "+", "Taller")}</span>`;
}

function workingSpaceHtml(ws, blockId, key, kind = "block") {
  if (ws.style === "none") return "";
  const spacing = ws.style === "lines" ? RULE_MM : GRID_MM;
  const height = snapDown(ws.heightMm, spacing);
  const grip = boxGripHtml(blockId, key, kind, spacing);
  if (ws.style === "grid") return gridBoxHtml(height, grip);
  if (ws.columns === 2) {
    // A grip on each column even though the two are one box and move
    // together: whichever half someone reaches for should be the one
    // that answers.
    const col = `<div class="working-space" style="height:${height}mm">${ruleLinesHtml(height, spacing)}${grip}</div>`;
    return `<div class="working-space-row">${col}${col}</div>`;
  }
  return `<div class="working-space" style="height:${height}mm">${ruleLinesHtml(height, spacing)}${grip}</div>`;
}

// The stand-in a teacher-workthrough export puts where the worked
// Solution was. Ruled by a tiled pattern rather than a fixed run of
// lines, so it can be given any height after layout and still fill it -
// see fitTeacherBlanks, which sizes it to the space actually cut out.
function blankSpaceHtml(ws) {
  const fill = ws.style === "lines" ? RULE_PATTERN_ID : GRID_PATTERN_ID;
  const height = snapDown(ws.heightMm, ws.style === "lines" ? RULE_MM : GRID_MM);
  return (
    `<div class="working-space ws-filled" style="height:${height}mm">` +
    `<svg class="ws-grid" preserveAspectRatio="none"><rect width="100%" height="100%" fill="url(#${fill})"></rect></svg>` +
    `</div>`
  );
}

// An answer box with a diagram floated beside part of it: ONE box, not
// a rectangle. Written as a single element whose outline and ruling are
// drawn as one SVG path, because that is the only way the L is really
// one box - built as two stacked boxes instead, the seam where they met
// showed as a line across the middle of the answer space and their
// edges never quite lined up. The box itself is a plain block, so it
// slides under the float the way any block does, and the notch cut out
// of its top-right corner is exactly where the diagram sits. The shape
// is measured after layout (see wrapWorkingSpaces) - until then it is
// the plain rectangle it would have been anyway.
function wrappedSpaceHtml(ws, blockId, key) {
  if (ws.style === "none") return "";
  const spacing = ws.style === "lines" ? RULE_MM : GRID_MM;
  const total = snapDown(ws.heightMm, spacing);
  const fill = ws.style === "lines" ? RULE_PATTERN_ID : GRID_PATTERN_ID;
  return (
    `<div class="working-space ws-shaped" style="height:${total}mm" data-step="${spacing}">` +
    `<svg class="ws-shape" preserveAspectRatio="none">` +
    `<path fill="url(#${fill})" stroke="#999" stroke-width="${(0.3 * MM_PX).toFixed(2)}"></path>` +
    `</svg>` +
    boxGripHtml(blockId, key, "block", spacing) +
    `</div>`
  );
}

function stylePickerHtml(target, kind, activeStyle) {
  const opts = [
    ["none", "None"],
    ["grid", "Grid"],
    ["lines", "Written response"],
  ];
  const buttons = opts
    .map(
      ([value, label]) =>
        `<button class="${activeStyle === value ? "active" : ""}" data-action="set-style" data-target="${target}" data-kind="${kind}" data-style="${value}">${label}</button>`
    )
    .join("");
  return `<div class="style-picker">${buttons}</div>`;
}

function columnsPickerHtml(target, kind, columns) {
  const opts = [[1, "1 col"], [2, "2 col"]];
  const buttons = opts
    .map(
      ([value, label]) =>
        `<button class="${columns === value ? "active" : ""}" data-action="set-columns" data-target="${target}" data-kind="${kind}" data-columns="${value}">${label}</button>`
    )
    .join("");
  return `<div class="columns-picker">${buttons}</div>`;
}

function sizeControlHtml(target, kind, ws) {
  if (ws.style === "none") return "";
  if (ws.style === "lines") {
    const rows = Math.max(1, Math.round(ws.heightMm / RULE_MM));
    return (
      '<div class="lines-picker">' +
      `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${RULE_MM}" data-delta="-1">−</button>` +
      `<span>${rows} line${rows !== 1 ? "s" : ""}</span>` +
      `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${RULE_MM}" data-delta="1">+</button>` +
      "</div>" +
      columnsPickerHtml(target, kind, ws.columns === 2 ? 2 : 1)
    );
  }
  const presetButtons = Object.entries(SIZE_PRESETS_MM)
    .map(([name, mm]) => {
      const active = ws.heightMm === mm ? "active" : "";
      return `<button class="${active}" data-action="set-size" data-target="${target}" data-kind="${kind}" data-size="${name}">${name[0].toUpperCase()}</button>`;
    })
    .join("");
  return (
    `<div class="size-picker">${presetButtons}` +
    `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${GRID_MM}" data-delta="-1">−</button>` +
    `<span>${ws.heightMm}mm</span>` +
    `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${GRID_MM}" data-delta="1">+</button>` +
    "</div>"
  );
}

// A diagram is usually the bigger lever for fitting more onto a page
// than the working-space box is (see IMAGE_SCALE_MAX in model.js), so
// this is offered as its own direct control, not just something the
// "squeeze in" prompt reaches for automatically.
function imageScaleControlHtml(target, kind, pct) {
  return (
    '<div class="image-scale-picker">' +
    "<span>Diagram:</span>" +
    `<button data-action="step-image-scale" data-target="${target}" data-kind="${kind}" data-delta="-1" ${pct <= IMAGE_SCALE_MIN ? "disabled" : ""}>−</button>` +
    `<span>${pct}%</span>` +
    `<button data-action="step-image-scale" data-target="${target}" data-kind="${kind}" data-delta="1" ${pct >= IMAGE_SCALE_MAX ? "disabled" : ""}>+</button>` +
    "</div>"
  );
}

// Manual escape hatch for the rare case automatic pagination gets a
// call wrong - pins this question/group to always start a fresh sheet,
// regardless of how much room is left on the one before it.
function breakBeforeControlHtml(target, kind, breakBefore) {
  return (
    `<button class="break-before-toggle ${breakBefore ? "active" : ""}" ` +
    `data-action="toggle-break-before" data-target="${target}" data-kind="${kind}">` +
    `${breakBefore ? "✓ Starts on a new page" : "Start on a new page"}</button>`
  );
}

// A standalone (non-grouped) question is only ever one thing wide - a
// full page-width row - by default, which wastes most of a sheet on a
// short Problem-solving/Reasoning question that would happily sit at
// half width next to whichever standalone question follows it (see
// pairQuestionUnits below, which actually builds that shared row once
// both sides are known). This only ever records the *intent*, on this
// question alone - which two questions actually end up sharing a row
// still depends on what's genuinely next once deletes/filters have
// already been resolved, so the merge itself has to happen later, not
// here.
function pairWithNextControlHtml(target, active) {
  return (
    `<button class="pair-with-next-toggle ${active ? "active" : ""}" ` +
    `data-action="toggle-pair-with-next" data-target="${target}" data-kind="block">` +
    `${active ? "✓ Split with next question" : "Split with next question"}</button>`
  );
}

// pct is always the already-resolved value (a block's own imageScale if
// it has one, else whichever workbook-wide default applies - see
// resolvedDefaultScales in model.js) - never "unset", now that unset no
// longer means a single fixed constant.
function renderQuestionControls(target, kind, ws, pct, breakBefore) {
  return (
    sizeControlHtml(target, kind, ws) +
    stylePickerHtml(target, kind, ws.style) +
    imageScaleControlHtml(target, kind, pct) +
    breakBeforeControlHtml(target, kind, breakBefore)
  );
}

function headingHtml(b) {
  const text = escapeHtml(b.text);
  if (b.style === "title") return `<div class="heading heading-title">${text}</div>`;
  if (b.style === "tier") return `<div class="heading heading-tier tier-${b.tier || "default"}">${text}</div>`;
  return `<div class="heading">${text}</div>`;
}

const DEFAULT_COMBINED_WS = { style: "grid", heightMm: SIZE_PRESETS_MM.medium };

// Returns one or more {html, heading} pagination units for a multi-part
// question group - never just one joined HTML string, because that
// would make the whole group one atomic block that pagination can only
// ever keep together or overflow, and a long split group very easily
// doesn't fit on one sheet (each part carries its own crop + working
// space + controls). The combined ("whole question") view really is a
// single crop image and stays atomic; split parts are independent and
// need to be free to land on different sheets, same as any other
// question would.
// One row of buttons - Combined, then 1/2/3/4 split - replacing what
// used to be two separate controls (a Split/Combined radio, then a
// cols picker that only appeared once Split was already chosen).
// Picking a split option sets the layout *and* the column count
// together in one click (see the "set-group-layout" handler in
// app.js), so going from Combined straight to "3 split" is one click,
// not two through an intermediate 2-column state. Always offers all
// four split widths regardless of how many parts the group actually
// has - a 2-part group showing "4 split" just renders one row with
// two of its four slots empty, never broken, and a fixed set of
// options is easier to scan than one whose choices shift per group.
// Building Understanding and Fluency groups are usually short,
// single-line parts (a quick "State whether..." or "Find x" per letter)
// that read fine three to a row - a Problem-solving/Reasoning/
// Enrichment group's parts are usually meatier (a diagram, a multi-line
// working-out box) and need the extra width two-per-row gives them.
// Both are still just a starting point the picker above can override
// per group at any time.
function groupLayoutPickerHtml(gid, layout, splitColumns) {
  const safeGid = escapeHtml(gid);
  const combinedBtn =
    `<button class="${layout === "combined" ? "active" : ""}" data-action="set-group-layout" ` +
    `data-group="${safeGid}" data-mode="combined">Combined</button>`;
  const splitBtns = [1, 2, 3, 4]
    .map(
      (n) =>
        `<button class="${layout !== "combined" && splitColumns === n ? "active" : ""}" data-action="set-group-layout" ` +
        `data-group="${safeGid}" data-mode="split" data-columns="${n}">${n} split</button>`
    )
    .join("");
  return `<span class="layout-picker">${combinedBtn}${splitBtns}</span>`;
}

function renderGroup(gid, blocks, layout, cropsBaseUrl, combinedBlocks, restorableHiddenMembers = [], defaultScales, splitColumns = 2, controlsMergedIntoStem = false) {
  // A group configured for N-split with fewer than N parts total (a
  // naturally 2-part question sitting under a tier that defaults to
  // 3-split, say) would otherwise still render one row stretched to N
  // columns' worth of width, with the missing column(s) just blank
  // space - cols-N's CSS divides the row width by N regardless of how
  // many parts actually exist. Clamping here fixes both the picker's
  // own "active" button and the row itself in one place. A *later* row
  // falling short (5 parts at 3-split leaving a 2-wide last row) is a
  // different case - handled per-row below, since the group's own
  // chosen split count is still correct there, just not every row's.
  splitColumns = Math.min(splitColumns, blocks.length) || 1;
  const safeGid = escapeHtml(gid);
  // The group-level controls' actual content (layout/columns picker,
  // delete, restore) - built once, then folded into whichever
  // collapsible shell fits where it ends up: the combined view already
  // has one hanging panel for everything else about this group (image
  // scale, break-before, crop), so this just becomes more of that same
  // panel's body rather than a second toggle stacked on top of it. A
  // split view has no such panel to fold into (its own hanging panel is
  // per-row, not per-group - see hangingControls below), so it gets a
  // small standalone collapsible of its own, sitting inline above the
  // first row (right where the group's stem, if it has one, already
  // sits - see _stem_block in groupify.py).
  const layoutControlsInner =
    groupLayoutPickerHtml(gid, layout, splitColumns) +
    deleteButtonHtml(gid, "group", "Delete question") +
    restoreListHtml(restorableHiddenMembers, gid);

  if (layout === "combined") {
    // The combined view is a real crop of the whole question exactly as
    // printed (all parts together), not a stack of the individual part
    // crops - that's what keeps it looking like a clean single block
    // instead of an awkward recomposition.
    const saved = combinedBlocks[gid];
    const ws = (saved && saved.workingSpace) || DEFAULT_COMBINED_WS;
    // A read-only stand-in for canShrink()/the controls below - the
    // group might never have been customized yet, so there's no real
    // combinedBlocks[gid] to point at; app.js's ensureCombinedBlock()
    // creates the real one on first edit, this is just for display.
    const entry = {
      workingSpace: ws,
      imageScale: saved && saved.imageScale,
      breakBefore: saved && saved.breakBefore,
      manualCropSrc: saved && saved.manualCropSrc,
    };
    const pct = entry.imageScale ?? defaultScales.combined;
    const crop = cropHtml(cropsBaseUrl, gid, undefined, undefined, pct, entry.manualCropSrc);
    // A combined crop spans close to the page's own width, so its
    // controls hang off the outer margin (see .controls-hang) instead
    // of stacking inline below it - unlike a split row's parts, which
    // stay inline (see partHtml below): those are only half-width and
    // sit mid-page, with no clean page edge to hang off of.
    const hangingControls = controlsHangHtml(gid, layoutControlsInner + renderQuestionControls(gid, "group", ws, pct, entry.breakBefore) + cropButtonHtml(gid, "group"));
    const html = `<div class="group">${crop}${workingSpaceHtml(ws, gid, "", "group")}${hangingControls}</div>`;
    const wsTargets = [{ kind: "group", id: gid, canShrink: canShrink(entry, defaultScales.combined) }];
    return [{ html, heading: false, groupId: gid, groupFirstRow: true, wsTargets, breakBefore: entry.breakBefore }];
  }

  // Split parts render two to a row (see .split-row) - most part crops
  // are far narrower than a full page, so one-per-row wasted most of the
  // sheet on blank margin either side of a small diagram. Each row is
  // its own pagination unit (never split part-from-partner), so a long
  // split question still breaks cleanly between rows across sheets; the
  // layout picker travels with the first row so it's never separated
  // from it. groupId/groupFirstRow let renderEditor glue a preceding
  // stem to this group's first row, and label any later row that ends
  // up starting a fresh sheet with which question it continues.
  // The "only one part left" / "second part in the row" width and gap
  // rules used to lean on :only-child/:last-child - which never actually
  // matched, since every row's hanging controls panel (see below) is
  // always one more sibling after the part(s), so neither part is ever
  // truly "last" or "only" in plain DOM terms. Passed in explicitly here
  // instead (as a class, not a structural selector), so the gap between
  // two parts, and the full-width single-part row, are never at the
  // mercy of whatever else happens to share the row.
  // Which of the two split-scale defaults (see DEFAULT_SPLIT_SCALE_2/_3
  // in model.js) applies is the group's own (already-clamped) column
  // count, not any one row's actual length - a group configured for
  // 3-split still reads as a 3-up group throughout even where its last
  // row happens to fall short (see the cols-<rowBlocks.length> comment
  // below, a separate CSS-only concern).
  const splitPct = splitScaleFor(defaultScales, splitColumns);
  const partHtml = (b, isOnly) => {
    const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, undefined, b.imageScale ?? splitPct, b.manualCropSrc);
    const cls = isOnly ? "block question split-only" : "block question";
    return `<div class="${cls}"${kindAttr(b)}>${crop}${workingSpaceHtml(b.workingSpace, b.id, "")}</div>`;
  };

  const units = [];
  for (let i = 0; i < blocks.length; i += splitColumns) {
    const rowBlocks = blocks.slice(i, i + splitColumns).filter(Boolean);
    const isOnly = rowBlocks.length === 1;
    const partsHtml = rowBlocks.map((b) => partHtml(b, isOnly)).join("");
    // A row's two parts are locked to one shared size/style/scale - a
    // matched pair never has a real reason to size differently, and one
    // shared panel (instead of a part's own panel either side plus a
    // third "Both" panel squeezed between them) is what actually fixes
    // the hanging-controls overlap: layoutHangingControls() only has to
    // stack whole rows top-to-bottom then, not referee three panels
    // fighting over the same vertical space at the same row height. The
    // panel's data-target carries both ids comma-joined, so every action
    // in app.js's click handler already applies to both parts at once
    // (see the targets.split(",") loop there) - no separate "apply to
    // both" affordance needed.
    const anchor = rowBlocks[0];
    const targets = rowBlocks.map((b) => b.id).join(",");
    // One delete button per part, not a shared comma-target one like
    // the rest of this panel - unlike size/style/scale, a matched pair
    // can each independently be dropped without the other, and a single
    // shared delete would take out both parts on one click.
    const partDeleteButtons = rowBlocks
      .map((b) => deleteButtonHtml(b.id, "block", `Delete ${partLabel(b.id, gid)}`))
      .join("");
    // Crop, like delete, is always per-part - each part is its own
    // distinct image, so a shared comma-target button would only ever
    // be able to crop one of the two anyway.
    const partCropButtons = rowBlocks.map((b) => cropButtonHtml(b.id, "block")).join("");
    const hangingControls = controlsHangHtml(targets, renderQuestionControls(targets, "block", anchor.workingSpace, anchor.imageScale ?? splitPct, anchor.breakBefore) + partDeleteButtons + partCropButtons);
    // cols-<rowBlocks.length>, not cols-<splitColumns> - a later row can
    // still fall short of the group's own chosen column count (5 parts
    // at 3-split leaves a 2-wide last row); sizing by what's actually in
    // *this* row keeps it genuinely full-width instead of stretched to
    // fit a column that has nothing in it. The group-level clamp above
    // only catches every row falling short (the whole group has fewer
    // parts than the split count), not just the last one.
    const rowHtml = `<div class="split-row cols-${rowBlocks.length}">${partsHtml}${hangingControls}</div>`;
    const isFirstRow = i === 0;
    // No hanging panel to fold into here (see layoutControlsInner above)
    // - its own small standalone collapsible, using .group-controls
    // itself as the toggle/body shell (same .controls-body mechanism as
    // .controls-hang, just laid out inline instead of pinned to the
    // page margin - see app.css).
    // Suppressed when the caller already folded this exact content into
    // the group's own stem panel instead (see mergeGroupControls in the
    // main render loop) - showing it again here would just be the same
    // picker/delete/restore twice for one question.
    const groupControlsHtml =
      controlsMergedIntoStem ? "" : `<div class="group-controls">${collapsibleToggleHtml(gid)}<div class="controls-body">${layoutControlsInner}</div></div>`;
    const html = `<div class="group">${isFirstRow ? groupControlsHtml : ""}${rowHtml}</div>`;
    const wsTargets = rowBlocks.map((b) => ({ kind: "block", id: b.id, canShrink: canShrink(b, splitPct) }));
    // A break-before toggled on either part in a row breaks before the
    // whole row - the two parts are always paginated as one atomic unit,
    // so "break before this part" can only ever mean "break before its
    // row."
    const breakBefore = rowBlocks.some((b) => b.breakBefore);
    units.push({ html, heading: false, groupId: gid, groupFirstRow: isFirstRow, wsTargets, breakBefore });
  }
  return units;
}

// A sheet that finished with a meaningful gap, and a following sheet
// (for the same logical page) still to come, is worth flagging - offer
// to shrink every working space already on this sheet plus the very
// next unit queued after it, which is often enough to pull that unit up
// onto the space that's currently going to waste.
function squeezeInHtml(sheetUnits, nextSheetUnits) {
  // If the very next thing queued up is a heading, it's always
  // glueForward - pagination bundles it with whatever comes right after
  // it precisely so it never sits stranded on its own (see bundleEnd).
  // A heading itself has nothing shrinkable, so looking at just
  // nextSheetUnits[0] would frequently offer nothing even when the real
  // question right behind that heading has plenty of room to give -
  // walk the same glued bundle bundleEnd() would, to find it.
  const nextBundle = [];
  for (const u of nextSheetUnits) {
    nextBundle.push(u);
    if (!u.glueForward) break;
  }

  const targets = [];
  for (const u of sheetUnits) if (u.wsTargets) targets.push(...u.wsTargets);
  for (const u of nextBundle) if (u.wsTargets) targets.push(...u.wsTargets);
  // Nothing to offer if every candidate is already at its floor (e.g.
  // "None" style, or already the smallest preset) - the button would
  // just sit there doing nothing when clicked.
  if (!targets.some((t) => t.canShrink)) return "";
  const idsAttr = targets.map((t) => `${t.kind}:${escapeHtml(t.id)}`).join(",");
  return `<button class="squeeze-in" data-action="squeeze-in" data-ids="${idsAttr}">There's room here - shrink to squeeze in the next question ↓</button>`;
}

// True for a page whose content is the start of a new named section (an
// exercise, or an "X Answers" divider) - add_chapter.py calls this style
// "title", reserved for exactly that. Every other logical workbook page
// is just how the source content happened to be chunked, not a break
// anyone actually wants - flowing those together, instead of pinning
// each to its own sheet, is what lets a title/Key Ideas/Building
// Understanding page that's mostly blank on its own share a sheet with
// its neighbours instead of wasting the rest of the page.
function isSectionStart(page) {
  const first = page.blocks[0];
  return !!first && first.type === "heading" && first.style === "title";
}

export async function renderEditor(workbook, cropsBaseUrl) {
  // Teaching material sideways, two columns a sheet - on unless the
  // workbook says otherwise (see the Landscape teaching button).
  const landscape = !!workbook.landscapeTeaching;
  // Every teaching panel's width in a landscape column, worked out from
  // the true size of its crop (see landPanelWidths).
  const landSizes = landscape ? landPanelWidths(workbook) : { width: new Map(), boxMm: new Map() };
  const landWidth = (b) => landSizes.width.get(b.id);
  currentBuildVersion = workbook.buildVersion || "";
  const combinedBlocks = workbook.combinedBlocks || {};
  const deletedIds = new Set(workbook.deletedIds || []);
  const filterCtx = buildFilterContext(workbook);
  const defaultScales = resolvedDefaultScales(workbook);
  const physicalPagesHtml = [];
  let pending = [];
  let pageNumber = 0;
  // Which chapter's title heading everything currently in `pending`
  // belongs to - stamped onto every physical page a flush produces (see
  // data-chapter below), so app.js's print-selection checkboxes can hide
  // a deselected chapter's own sheets at print time without needing to
  // know anything about pagination itself. Updated only on a *content*
  // chapter's own title (isRealChapterTitle below), never on its
  // "X Answers" title right after it - answers stay tagged with the
  // same chapter id as the content they belong to, since one print
  // selection checkbox covers both. Read by flushPending() below at the
  // point each physical page is actually pushed - always still holding
  // the *previous* chapter's id there, since the main loop only updates
  // it after flushPending() has already drained everything queued
  // ahead of the new title.
  let currentChapterId = null;
  // Group ids whose Combined/1-4-split picker got folded into their
  // stem's own hanging panel instead of a separate standalone chip (see
  // the stem-detection lookahead below) - checked when that group
  // itself gets rendered further down, so renderGroup() knows not to
  // show a second, redundant copy of the same picker.
  const mergedStemGids = new Set();

  // Packs and emits whatever's been queued up since the last hard break
  // (a cover, or a section start) as physical sheets - see paginateUnits
  // for why this has to happen across every logical page in the pending
  // run at once, not one logical page at a time: only that lets a stem
  // that landed at the end of one source page glue to its group's first
  // row on the next, and lets a short page's leftover room actually get
  // filled by whatever now-following content fits in it.
  async function flushPending() {
    if (pending.length === 0) return;
    const units = pairQuestionUnits(pairAnswerImageUnits(pending));
    pending = [];

    // A heading is never worth stranding alone at the bottom of a sheet -
    // it always glues to whatever comes right after it (one hop: just
    // the very next unit, whatever that is - not a chain, so a heading
    // followed by a large worked example doesn't drag along everything
    // after that example too). A plain context-only unit (an image with
    // no working space) only glues forward when it's *specifically* the
    // stem for the group it immediately precedes - matched by the
    // "{groupId}_stem" naming convention add_chapter.py uses for these,
    // not just "any image directly before any group": a worked example's
    // own diagram sitting right before an unrelated exercise's group is
    // still just an image with no working space, but it isn't that
    // group's stem, and gluing it in anyway produced bundles several
    // unrelated blocks deep and taller than a page (see bundleEnd() in
    // paginateUnits() for how an atomic bundle that doesn't fit still
    // gets kept together rather than split, which is exactly why an
    // unbounded chain here is dangerous).
    const groupStems = {};
    for (let i = 0; i < units.length; i++) {
      if (!units[i].groupId || !units[i].groupFirstRow) continue;
      const prev = units[i - 1];
      if (prev && prev.contextOnly && prev.id === `${units[i].groupId}_stem`) {
        prev.glueForward = true;
        // The unit object, not a snapshot of its .html - growth-locked
        // marking (below) mutates that string in place after this point,
        // and a "(continued)" repeat should reflect the same disabled
        // controls as the original, not a stale unmarked copy.
        groupStems[units[i].groupId] = prev;
      }
    }
    for (let i = 0; i < units.length; i++) {
      units[i].glueForward = units[i].glueForward || units[i].heading;
    }

    // Teaching material goes on its own landscape sheets, two columns of
    // it to a page (see LAND_COL_MM) - it is cropped too narrow to fill a
    // portrait column and there is nothing to put beside it. Everything
    // else stays portrait. Runs are kept in document order, so a
    // section reads Key Ideas and its examples sideways, then turns back
    // upright for the exercise.
    const runs = [];
    for (const u of units) {
      const kind = u.teaching && landscape ? "teaching" : "flow";
      if (!runs.length || runs[runs.length - 1].kind !== kind) runs.push({ kind, units: [] });
      runs[runs.length - 1].units.push(u);
    }
    // A heading glued to what follows it goes wherever that goes. The
    // chapter title sits immediately before its Key Ideas, so without
    // this every section opened with a portrait sheet carrying nothing
    // but its own title while the teaching turned sideways behind it.
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].kind !== "teaching") continue;
      const prev = runs[i - 1].units;
      while (prev.length && prev[prev.length - 1].glueForward) runs[i].units.unshift(prev.pop());
    }
    for (const run of runs.filter((r) => r.units.length)) {
      if (run.kind === "teaching") await emitLandscape(run.units);
      else await emitPortrait(run.units, groupStems);
    }
  }

  // Teaching material on landscape sheets, two columns to a sheet.
  //
  // The packing is done a SHEET at a time - a bin of two columns - and
  // the units that land on one are then poured into its two columns.
  // Packing each column as its own bin instead looks equivalent and is
  // much worse: a worked example is nearly a full column tall, so every
  // column that could not fit the next one left a third of itself empty
  // and the sideways layout came out longer than the portrait one it
  // replaced. Pouring means an example can begin in the left column and
  // finish in the right, which is how two columns are read anyway,
  // while the sheet boundary still falls where the packer put it.
  async function emitLandscape(units) {
    const { sheets, heights } = await paginateUnits(units, {
      widthMm: LAND_COL_MM,
      usablePx: 2 * LAND_COL_PX,
    });
    const heightOf = new Map();
    units.forEach((u, i) => heightOf.set(u, heights[i]));
    for (let i = 0; i < sheets.length; i++) {
      const cols = [[], []];
      let used = 0;
      let col = 0;
      const sheet = sheets[i];
      // Poured a BUNDLE at a time, not a unit at a time: an example's
      // question, its worked answer and its "Now you try" are one thing,
      // and each is already scaled to fit a single column (see
      // landPanelWidths), so there is never a reason to break one across
      // the fold - which is what pouring unit by unit did, leaving a
      // "Now you try" and its box alone in a column.
      for (let k = 0; k < sheet.length; ) {
        const last = sheet[k].glueForward ? bundleEnd(sheet, k) : k;
        const items = sheet.slice(k, last + 1);
        const h = items.reduce((sum, u) => sum + (heightOf.get(u) || 0), 0);
        // Move to the second column when this bundle would overflow the
        // first - unless nothing is in the first yet, in which case it
        // has to go there whatever its height.
        if (col === 0 && used > 0 && used + h > LAND_COL_PX) {
          col = 1;
          used = 0;
        }
        cols[col].push(...items);
        used += h;
        k = last + 1;
      }
      const side = physicalPagesHtml.length % 2 === 0 ? "page-left" : "page-right";
      pageNumber++;
      const chapterAttr = currentChapterId ? ` data-chapter="${escapeHtml(currentChapterId)}"` : "";
      const colsHtml = cols
        .filter((c, n) => c.length || n === 0)
        .map((c) => `<div class="landscape-col">${c.map((u) => u.html).join("")}</div>`)
        .join("");
      physicalPagesHtml.push(
        `<div class="page page-landscape ${side}"${chapterAttr}>${colsHtml}` +
          `<div class="page-number">${pageNumber}</div></div>`
      );
    }
  }

  // groupStems is passed in rather than closed over: it is built per
  // flush, and this function lives outside that scope.
  async function emitPortrait(units, groupStems) {
    const { sheets, leftoverPx, oversizedBundle } = await paginateUnits(units);
    for (let i = 0; i < units.length; i++) {
      if (oversizedBundle[i]) units[i].html = markGrowthLocked(units[i].html);
    }
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];
      // A later row of a split question can still end up starting a
      // fresh sheet if the whole question doesn't fit one page - without
      // some marker, that sheet would open on bare parts with no visible
      // indication of which question they belong to ("the question
      // disappears"). Repeat its stem if it has one; a bare id label is
      // the fallback for the (rare, best avoided going forward) group
      // that was never given a separate stem crop to begin with.
      const first = sheet[0];
      let continued = "";
      if (first && first.groupId && !first.groupFirstRow) {
        const stemUnit = groupStems[first.groupId];
        continued = (stemUnit && stemUnit.html) || `<div class="heading group-continued">${escapeHtml(first.groupId)} (continued)</div>`;
      }
      // Only a sheet with more content still queued behind it can
      // usefully squeeze anything in - the last sheet has nothing left
      // to pull forward.
      const squeeze =
        i < sheets.length - 1 && leftoverPx[i] >= MIN_SQUEEZE_PX ? squeezeInHtml(sheet, sheets[i + 1]) : "";
      // Which side of a two-up spread this sheet lands on - lets a
      // block's hanging controls (see .controls-hang in app.css) flip to
      // whichever outer margin is actually free, entirely in CSS.
      const side = physicalPagesHtml.length % 2 === 0 ? "page-left" : "page-right";
      pageNumber++;
      const pageNumberHtml = `<div class="page-number">${pageNumber}</div>`;
      const chapterAttr = currentChapterId ? ` data-chapter="${escapeHtml(currentChapterId)}"` : "";
      physicalPagesHtml.push(`<div class="page ${side}"${chapterAttr}>${continued}${sheet.map((u) => u.html).join("")}${squeeze}${pageNumberHtml}</div>`);
    }
  }

  for (const page of workbook.pages) {
    if (page.cover) {
      // A cover is always exactly one full-bleed image, and always its
      // own sheet - flush whatever was flowing before it, render it
      // directly (no controls: none of squeeze-in/diagram-scale/manual
      // break make sense on a page that's deliberately outside normal
      // pagination), then carry on with a clean slate after.
      await flushPending();
      const b = page.blocks[0];
      const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm);
      // Empty placeholder, always present - app.js fills this in with
      // which chapters are actually included whenever the print-
      // selection checkboxes (see printSelectionBarHtml) leave out part
      // of the book, entirely by mutating this node's text after the
      // fact rather than re-rendering: the selection can change far more
      // often than the workbook itself does, and redoing this whole
      // (expensive) render pass on every checkbox click would be wasteful.
      // Collapses to nothing (see :empty in app.css) the rest of the
      // time, so a full-selection export still looks exactly like a
      // plain full-bleed cover.
      physicalPagesHtml.push(`<div class="page page-cover">${crop}<div class="cover-print-note"></div></div>`);
      continue;
    }

    const renderUnits = iterRenderUnits(page.blocks);
    const units = [];
    renderUnits.forEach((unit, unitIndex) => {
      if (unit.kind === "single") {
        const b = unit.blocks[0];
        // A stem image cropped from the same source region as a group's
        // "combined" (whole-question) crop is already baked into that
        // crop - only show it separately when the group is split into
        // parts, or it'd print twice back to back in combined view. And
        // whether baked-in or not, a stem introducing a group that's
        // entirely hidden (deleted, or filtered out - see
        // groupVisibility) has nothing left to introduce.
        const next = renderUnits[unitIndex + 1];
        let mergeGroupControls = null;
        if (next && next.kind === "group") {
          const nextLayout = workbook.groupLayout[next.gid] || "split";
          const nextVisibility = groupVisibility(workbook, next.gid, next.blocks, filterCtx, deletedIds);
          if (b.combinedIncludesStem && nextLayout === "combined") return;
          if (nextVisibility.fullyHidden && (b.combinedIncludesStem || (b.type === "image" && b.id === `${next.gid}_stem`))) {
            return;
          }
          // A split group's own layout/columns picker used to always be
          // its own small standalone chip, sitting inline right above
          // the group's first row. When the group actually has a stem
          // (its leading instruction line - see _stem_block in
          // groupify.py), that chip ends up as a second, separate
          // clickable thing right next to the stem's own panel for no
          // real reason - folding the picker into the stem's panel
          // instead reads as one control per question, not two. Only
          // for split layout: combined already consolidates everything
          // (picker included) into its own one hanging panel regardless
          // of whether a stem exists (see renderGroup), so there's
          // nothing to merge there.
          if (b.type === "image" && b.id === `${next.gid}_stem` && nextLayout !== "combined") {
            mergeGroupControls = { gid: next.gid, layout: nextLayout, restorableHiddenMembers: nextVisibility.explicitlyHiddenMembers };
            mergedStemGids.add(next.gid);
          }
        }
        if (b.type === "flowquestion") {
          // The text-flow pipeline's question (see tools/extract_flow.py).
          // Unlike every other block here it carries no whole-question
          // bitmap: its prose is real text set at one workbook-wide size,
          // and only its figures are images - which is what lets it wrap
          // into a narrow column instead of shrinking, and lets a figure
          // be resized without dragging the words down with it.
          if (deletedIds.has(b.id)) {
            units.push({ html: deletedPlaceholderHtml(b.id, b.id), heading: false, breakBefore: false });
            return;
          }
          if (!passesWholeQuestionFilter(workbook, filterCtx.context[b.id])) return;
          // From here on the question is whatever the Fluency sub-part
          // filter left of it, not necessarily the block as stored.
          const shown = flowFilteredBlock(workbook, b, filterCtx.context[b.id]);
          if (!shown) return;
          const ws = b.workingSpace || { style: "grid", heightMm: 15 };
          const figPct = b.imageScale ?? defaultScales.combined;
          const controls = controlsHangHtml(
            b.id,
            renderQuestionControls(b.id, "block", ws, figPct, b.breakBefore) +
              deleteButtonHtml(b.id, "block", "Delete question") +
              pairWithNextControlHtml(b.id, !!b.pairWithNext)
          );
          // A grid more than two rows deep is emitted a row at a time,
          // so it can flow over a page break instead of moving whole.
          // The head (number, stem, shared diagrams) glues to the first
          // row so it can never be orphaned at the foot of a page.
          // Single-column part lists split too, not just grids. A
          // twelve-part question set one per line is far taller than a
          // page, and as one atomic unit it simply overflowed the
          // sheet - the last parts printed past the bottom edge.
          const rows = flowQuestionRows(shown, figPct);
          // ANY multi-row question is emitted a row at a time, so it can
          // flow over a page break instead of moving whole. It used to
          // take three rows before a question would split at all, which
          // left the two-row ones - 3E Q2 among them - unable to start
          // at the foot of a sheet: half of page 4 went blank because
          // the question after it could only move as one piece. The head
          // (number, stem, shared diagram) glues to the first row so it
          // can never be orphaned at the foot of a page.
          // Each row is broken further wherever a part's sub-items can
          // stand on their own lines, so a question can start in
          // whatever is left at the foot of a sheet instead of moving
          // whole to the next one.
          const pieces = [];
          rows.forEach((row, ri) => {
            splitPartRows(row).forEach((r, k) => {
              pieces.push({ row: r, rowIndex: ri, head: ri === 0 && k === 0, first: k === 0 });
            });
          });
          if (pieces.length > 1) {
            // A question repeats its number, its wording and any diagram
            // of its own at the top of a sheet it continues onto: "write
            // the ratio for triangle A" is unanswerable on a page that
            // shows neither the instruction nor triangle A. Only when
            // the continuation actually opens a sheet (see
            // paginateUnits) - mid-page it would just be the same thing
            // twice.
            const repeatHtml = (shown.stem || []).length || (shown.figures || []).length
              ? `<div class="block question flowq flowq-repeat">` +
                flowQuestionHtml(shown, cropsBaseUrl, ws, figPct, { row: null, head: true, rowIndex: 0, repeat: true }) +
                `</div>`
              : "";
            pieces.forEach((piece, pi) => {
              // The row-columns button belongs to the row, so it goes on
              // the piece that starts one - never on a sub-item tail.
              const slice = { row: piece.row, head: piece.head, rowIndex: piece.rowIndex, noRowControl: !piece.first };
              const rowHtml = flowQuestionHtml(shown, cropsBaseUrl, ws, figPct, slice);
              units.push({
                html: `<div class="block question flowq${pi ? " flowq-cont" : ""}">${rowHtml}${pi === 0 ? controls : ""}</div>`,
                heading: false,
                wsTargets: pi === 0
                  ? [{ kind: "block", id: b.id, canShrink: canShrink(b, defaultScales.combined) }]
                  : [],
                breakBefore: pi === 0 ? !!b.breakBefore : false,
                // No glue between the first row and the second. The head
                // is emitted WITH the first row, not on its own, so
                // there is nothing here that can be orphaned - and
                // gluing them was what stopped a question starting in
                // the space left at the foot of a sheet: 3E Q2's first
                // row fitted the 40% of page 4 that was going begging,
                // but was dragged onto the next sheet by its second.
                repeatHtml: pi === 0 ? "" : repeatHtml,
              });
            });
            return;
          }
          const html = flowQuestionHtml(shown, cropsBaseUrl, ws, figPct) + controls;
          units.push({
            html: `<div class="block question flowq">${html}</div>`,
            heading: false,
            wsTargets: [{ kind: "block", id: b.id, canShrink: canShrink(b, defaultScales.combined) }],
            breakBefore: !!b.breakBefore,
            pairData: { id: b.id, crop: flowQuestionHtml(shown, cropsBaseUrl, ws, figPct), ws, pct: figPct, breakBefore: !!b.breakBefore, wantsPair: !!b.pairWithNext, wsInCrop: true },
          });
          return;
        }
        if (b.type === "heading") {
          // Wrapped in one container, not two sibling top-level elements
          // (the heading div plus a bare button) - paginateUnits()
          // measures by reading one getBoundingClientRect() per DOM
          // child and assumes that lines up 1:1 with the units array;
          // two top-level children per unit desyncs every measurement
          // after the first heading in a run, corrupting every height
          // downstream of it. A real chapter title also carries its own
          // tier-filter row (see filterBarHtml) - kept inside this same
          // out-of-flow panel, same reasoning as breakBeforeControlHtml
          // just above it: it's editor chrome, never worth costing real
          // page space or nudging where a page break falls.
          const isChapterTitle = b.style === "title" && !/answers$/i.test(b.text || "");
          // Marks the one heading Auto-fit's section-compaction pass (see
          // app.js) looks for by exact text - a stable, consistent string
          // across every chapter's proposals, not worth a dedicated field
          // just for this.
          const isBuildingUnderstanding = (b.text || "").trim() === "Building Understanding";
          const html = `<div class="heading-unit"${isBuildingUnderstanding ? ' data-bu-heading="true"' : ""}>${headingHtml(b)}<div class="controls-hang">${breakBeforeControlHtml(b.id, "block", b.breakBefore)}${isChapterTitle ? filterBarHtml(workbook, b.id) : ""}</div></div>`;
          units.push({ html, heading: true, breakBefore: !!b.breakBefore });
        } else if (b.type === "image") {
          // No working space on a plain image, but it can still be the
          // tallest thing on a page (a full Key Ideas diagram, say) - it
          // still gets a diagram-scale control and can still be a
          // "squeeze in" target, just not the size/style pickers that
          // only make sense for an actual answerable question. Hung off
          // the page like a combined group's controls (see there) - a
          // plain image block is always full width. A Key Ideas summary
          // or worked-example diagram (see "section" in add_chapter.py)
          // is informational, not a question - its own default-scale
          // bucket, separate from an actual question's combined crop.
          // A teaching panel on a landscape sheet fills its column - the
          // column is about the width the book prints it at, so the
          // "section" shrink that stops it being oversized in a portrait
          // column is exactly what would leave it undersized here.
          const pct =
            b.imageScale ??
            (b.section ? defaultScales.section : b.answers ? defaultScales.answers : defaultScales.combined);
          const crop = cropHtml(
            cropsBaseUrl, b.id, b.contextImage,
            (b.imageScale ? 0 : landWidth(b)) || b.widthMm, pct, b.manualCropSrc
          );
          const ownControls = imageScaleControlHtml(b.id, "block", pct) + breakBeforeControlHtml(b.id, "block", b.breakBefore) + cropButtonHtml(b.id, "block");
          // Merged case (see mergeGroupControls above): one panel, labelled
          // by the group's own id (not the stem's), since the picker is
          // now the more important half of what it controls.
          const hangingControls = mergeGroupControls
            ? controlsHangHtml(
                mergeGroupControls.gid,
                ownControls +
                  groupLayoutPickerHtml(mergeGroupControls.gid, mergeGroupControls.layout, workbook.groupSplitColumns?.[mergeGroupControls.gid] || defaultSplitColumnsFor(mergeGroupControls.gid, filterCtx.context[mergeGroupControls.gid]?.tier)) +
                  deleteButtonHtml(mergeGroupControls.gid, "group", "Delete question") +
                  restoreListHtml(mergeGroupControls.restorableHiddenMembers, mergeGroupControls.gid)
              )
            : controlsHangHtml(b.id, ownControls);
          // glueForward is already exactly "this is a worked example's
          // own diagram" in this dataset (see the docstring in
          // add_chapter.py) - reused here as Auto-fit's other
          // section-compaction marker, rather than a second flag meaning
          // the same thing.
          const html = `<div class="block"${kindAttr(b)}${b.glueForward ? ' data-glue-example="true"' : ""}>${crop}${hangingControls}</div>`;
          units.push({
            html,
            heading: false,
            contextOnly: true,
            id: b.id,
            // Author-set at build time (add_chapter.py), not a runtime
            // editor toggle - separate from the automatic "{groupId}_stem"
            // detection below, for content where there's no group to
            // detect: a worked example's diagram has nothing to do
            // stranded without the "Now you try" that explains it, same
            // as a heading never wants to be stranded from what it
            // introduces, but no naming convention ties the id conventions
            // together the way a stem's does.
            glueForward: !!b.glueForward,
            teaching: !!b.section,
            wsTargets: [{ kind: "block", id: b.id, canShrink: canShrink(b, pct) }],
            breakBefore: !!b.breakBefore,
            // Raw pieces for pairAnswerImageUnits() to rebuild a 2-up row
            // from, if this turns out to sit right next to another answer
            // page image once the whole flush run is assembled - answer
            // pages are usually much narrower than a full page, and one
            // per row wastes most of the sheet the same way an unpaired
            // split question part used to (see renderGroup).
            answersImage: b.answers ? { id: b.id, crop, pct, breakBefore: !!b.breakBefore } : null,
          });
        } else {
          // A standalone question (no letter suffix, never grouped) is
          // never subject to Fluency's sub-part filter - there's only
          // ever the one "part" - only the whole-question one, same as
          // Problem-solving/Reasoning/Enrichment.
          if (deletedIds.has(b.id)) {
            units.push({ html: deletedPlaceholderHtml(b.id, b.id), heading: false, breakBefore: false });
            return;
          }
          if (!passesWholeQuestionFilter(workbook, filterCtx.context[b.id])) return;
          // A "Now you try" is a question, but its crop is a teaching
          // panel like the example above it - same bucket, so the two
          // never drift apart in size.
          const pct = b.imageScale ?? (b.section ? defaultScales.section : defaultScales.combined);
          const crop = cropHtml(
            cropsBaseUrl, b.id, b.contextImage,
            (b.imageScale ? 0 : landWidth(b)) || b.widthMm, pct, b.manualCropSrc
          );
          // In a landscape column the box takes whatever the example
          // above it left of the column, rather than the height built
          // for half a portrait page.
          const landBox = landSizes.boxMm.get(b.id);
          const ws = landBox ? { ...b.workingSpace, heightMm: landBox } : b.workingSpace;
          const hangingControls = controlsHangHtml(b.id, renderQuestionControls(b.id, "block", ws, pct, b.breakBefore) + pairWithNextControlHtml(b.id, !!b.pairWithNext) + deleteButtonHtml(b.id, "block", "Delete question") + cropButtonHtml(b.id, "block"));
          const html = `<div class="block question"${kindAttr(b)}>${crop}${workingSpaceHtml(ws, b.id, "")}${hangingControls}</div>`;
          units.push({
            html,
            heading: false,
            wsTargets: [{ kind: "block", id: b.id, canShrink: canShrink(b, defaultScales.combined) }],
            breakBefore: !!b.breakBefore,
            // Raw pieces for pairQuestionUnits() to rebuild a shared
            // half-width row from, if this question asked to share a
            // row with whatever standalone question turns out to follow
            // it (wantsPair) - same idea as answersImage above, just for
            // an editor-set choice instead of an automatic one.
            pairData: { id: b.id, crop, ws: b.workingSpace, pct, breakBefore: !!b.breakBefore, wantsPair: !!b.pairWithNext },
            teaching: !!b.section,
          });
        }
        return;
      }
      if (unit.kind === "sideImage") {
        // A decorative photo/diagram beside a run of standalone questions
        // (see besideQuestions in add_chapter.py) - unlike a plain image
        // block, this one never gets its own top-level unit; it renders
        // in the same flex row as the questions it sits beside, sized by
        // its own natural aspect ratio (see .side-image-photo img in
        // app.css - width-capped, height auto, never stretched to match
        // the text column's height the way a merged text+photo crop
        // would be).
        const imgBlock = unit.imageBlock;
        // Always the combined (full-size) default, never the section
        // bucket - a besideQuestions photo is tied to real questions (see
        // add_chapter.py's docstring), unlike a standalone Key Ideas/
        // worked-example diagram, so it shouldn't start pre-shrunk the
        // way that bucket's own lower default would otherwise leave it.
        const pct = imgBlock.imageScale ?? defaultScales.combined;
        const crop = cropHtml(cropsBaseUrl, imgBlock.id, imgBlock.contextImage, imgBlock.widthMm, pct, imgBlock.manualCropSrc);
        const imgControls = controlsHangHtml(
          imgBlock.id,
          imageScaleControlHtml(imgBlock.id, "block", pct) + breakBeforeControlHtml(imgBlock.id, "block", imgBlock.breakBefore) + cropButtonHtml(imgBlock.id, "block")
        );
        const wsTargets = [{ kind: "block", id: imgBlock.id, canShrink: canShrink(imgBlock, pct) }];
        const questionHtml = [];
        for (const qb of unit.blocks) {
          if (deletedIds.has(qb.id)) {
            questionHtml.push(deletedPlaceholderHtml(qb.id, qb.id));
            continue;
          }
          if (!passesWholeQuestionFilter(workbook, filterCtx.context[qb.id])) continue;
          const qPct = qb.imageScale ?? defaultScales.combined;
          const qCrop = cropHtml(cropsBaseUrl, qb.id, qb.contextImage, qb.widthMm, qPct, qb.manualCropSrc);
          const qControls = controlsHangHtml(
            qb.id,
            renderQuestionControls(qb.id, "block", qb.workingSpace, qPct, qb.breakBefore) + deleteButtonHtml(qb.id, "block", "Delete question") + cropButtonHtml(qb.id, "block")
          );
          questionHtml.push(`<div class="block question">${qCrop}${workingSpaceHtml(qb.workingSpace, qb.id, "")}${qControls}</div>`);
          wsTargets.push({ kind: "block", id: qb.id, canShrink: canShrink(qb, defaultScales.combined) });
        }
        const html = `<div class="side-image-row"><div class="side-image-text">${questionHtml.join("")}</div><div class="side-image-photo">${crop}${imgControls}</div></div>`;
        units.push({ html, heading: false, wsTargets, breakBefore: !!imgBlock.breakBefore });
        return;
      }
      if (unit.kind === "workthrough") {
        // A worked example's ordinary Solution+Explanation image (see
        // teacherSolutionId in add_chapter.py) plus the Solution
        // (blankable)/Explanation pair it stands in front of - all three
        // always render, unconditionally; which one actually shows is a
        // pure print-only CSS toggle (.workthrough-combined/
        // .workthrough-split, .teacher-solution-crop/-blank in app.css),
        // never anything this render pass has to decide. Combined is
        // what's visible by default (on screen always, and in a plain
        // print/export) - the split pair only appears when the "teacher
        // workthrough" checkbox (see applyPrintSelection in app.js) is
        // on AND this is actually printing.
        const combB = unit.combinedBlock;
        const solB = unit.solutionBlock;
        const expB = unit.explanationBlock;
        // A worked example is teaching material like the Example panel
        // above it (see "section" in tools/extract_flow.py) - the whole
        // trio has to scale together or the solution prints half again
        // as large as the question it answers.
        const sectionPct = (blk) =>
          blk.imageScale ?? (blk.section ? defaultScales.section : defaultScales.combined);
        const combPct = sectionPct(combB);
        const combCrop = cropHtml(
          cropsBaseUrl, combB.id, combB.contextImage,
          (combB.imageScale ? 0 : landWidth(combB)) || combB.widthMm, combPct, combB.manualCropSrc
        );
        const combControls = controlsHangHtml(
          combB.id,
          imageScaleControlHtml(combB.id, "block", combPct) + breakBeforeControlHtml(combB.id, "block", combB.breakBefore) + cropButtonHtml(combB.id, "block")
        );
        const solPct = sectionPct(solB);
        const solCrop = cropHtml(cropsBaseUrl, solB.id, solB.contextImage, solB.widthMm, solPct, solB.manualCropSrc);
        const blankWs = { style: solB.blankStyle || "grid", heightMm: solB.blankHeightMm || 20 };
        const solControls = controlsHangHtml(
          solB.id,
          imageScaleControlHtml(solB.id, "block", solPct) + breakBeforeControlHtml(solB.id, "block", solB.breakBefore) + cropButtonHtml(solB.id, "block")
        );
        const expPct = sectionPct(expB);
        const expCrop = cropHtml(cropsBaseUrl, expB.id, expB.contextImage, expB.widthMm, expPct, expB.manualCropSrc);
        const expControls = controlsHangHtml(
          expB.id,
          imageScaleControlHtml(expB.id, "block", expPct) + breakBeforeControlHtml(expB.id, "block", expB.breakBefore) + cropButtonHtml(expB.id, "block")
        );
        const html =
          `<div class="workthrough-unit">` +
          `<div class="workthrough-combined"${kindAttr(combB)}>${combCrop}${combControls}</div>` +
          `<div class="workthrough-split"><div class="workthrough-row">` +
          `<div class="workthrough-solution"${kindAttr(solB)}>` +
          `<div class="teacher-solution-crop">${solCrop}</div>` +
          `<div class="teacher-solution-blank">${blankSpaceHtml(blankWs)}</div>` +
          `${solControls}</div>` +
          `<div class="workthrough-explanation"${kindAttr(expB)}>${expCrop}${expControls}</div>` +
          `</div></div>` +
          `</div>`;
        const wsTargets = [
          { kind: "block", id: combB.id, canShrink: canShrink(combB, combPct) },
          { kind: "block", id: solB.id, canShrink: canShrink(solB, solPct) },
          { kind: "block", id: expB.id, canShrink: canShrink(expB, expPct) },
        ];
        // glueForward has to be read explicitly here (not left to fall
        // through from some default) - a workthrough unit is one atomic
        // pagination unit, so whatever the source combined block asked
        // for (glued into an example's own prompt-before/Now-you-try-
        // after chain - see build_10*.py) has to survive being folded
        // from three blocks into one unit here, the same as the group-
        // stem auto-glue detection above already relies on for its own
        // chain.
        units.push({
          html, heading: false, wsTargets,
          breakBefore: !!combB.breakBefore, glueForward: !!combB.glueForward,
          teaching: !!combB.section,
        });
        return;
      }
      const layout = workbook.groupLayout[unit.gid] || "split";
      const visibility = groupVisibility(workbook, unit.gid, unit.blocks, filterCtx, deletedIds);
      if (visibility.wholeGroupExplicitDelete) {
        units.push({ html: deletedPlaceholderHtml(unit.gid, unit.gid), heading: false, breakBefore: false });
        return;
      }
      if (visibility.wholeGroupAutoHidden) return;
      if (visibility.visibleMembers.length === 0) {
        // Every part is individually deleted - the fluency auto filter
        // alone can never zero every part out (odds/evens always keeps
        // at least one of any two consecutive positions), so this only
        // happens from deleting parts one by one. Restore needs to bring
        // all of them back together, not just the group id (which was
        // never itself deleted in this case).
        const ids = visibility.explicitlyHiddenMembers.map((m) => m.id).join(",");
        units.push({ html: deletedPlaceholderHtml(ids, unit.gid), heading: false, breakBefore: false });
        return;
      }
      units.push(
        ...renderGroup(unit.gid, visibility.visibleMembers, layout, cropsBaseUrl, combinedBlocks, visibility.explicitlyHiddenMembers, defaultScales, workbook.groupSplitColumns?.[unit.gid] || defaultSplitColumnsFor(unit.gid, filterCtx.context[unit.gid]?.tier), mergedStemGids.has(unit.gid))
      );
    });

    if (isSectionStart(page)) {
      await flushPending();
      // See currentChapterId above - only a real chapter's own title
      // moves it forward; an "X Answers" title (also isSectionStart,
      // since it's the same heading style) leaves it as whatever real
      // chapter came before, so the answers stay grouped with it.
      const title = page.blocks[0];
      if (!/answers$/i.test(title.text || "")) currentChapterId = title.id;
    }
    pending.push(...units);
  }
  await flushPending();

  // One inline custom property drives every flowed question's size (see
  // --flow-body in app.css) - a text-flow chapter has exactly one body
  // size by design, so it is set once here rather than per block.
  const flowStyle = workbook.flowVersion ? ` style="--flow-body:${flowBodyPt(workbook)}pt"` : "";

  // Two portrait sheets to a spread as always, but a landscape sheet is
  // as wide as two of them and takes a row on its own.
  const spreads = [];
  for (let i = 0; i < physicalPagesHtml.length; ) {
    const wide = physicalPagesHtml[i].includes("page-landscape");
    const take = wide || (physicalPagesHtml[i + 1] || "").includes("page-landscape") ? 1 : 2;
    spreads.push(`<div class="spread">${physicalPagesHtml.slice(i, i + take).join("")}</div>`);
    i += take;
  }
  // One copy of the grid pattern for the whole document - every
  // working-space grid box just references it by id (see gridBoxHtml).
  const body = flowStyle ? `<div${flowStyle}>${spreads.join("")}</div>` : spreads.join("");
  return gridPatternDefs() + body;
}
