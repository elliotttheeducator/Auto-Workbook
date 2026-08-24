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
  BOX_WIDTH_MM,
  CONTENT_WIDTH_MM,
  FILTER_MODES,
  GRID_MM,
  IMAGE_SCALE_MAX,
  IMAGE_SCALE_MIN,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
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
  const partHtml = (q) => `<div class="block question">${q.crop}${workingSpaceHtml(q.ws)}</div>`;
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
export function alignSplitRows(container) {
  for (const row of container.querySelectorAll(".split-row, .answer-row")) {
    const crops = Array.from(row.children)
      .filter((el) => el.classList.contains("block"))
      .map((el) => el.querySelector(".block-crop"))
      .filter(Boolean);
    if (crops.length < 2) continue;
    for (const c of crops) c.style.minHeight = "";
    const maxHeight = Math.max(...crops.map((c) => c.getBoundingClientRect().height));
    for (const c of crops) c.style.minHeight = `${maxHeight}px`;
  }
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
async function paginateUnits(units) {
  const measurer = getMeasurer();
  measurer.innerHTML = units.map((u) => u.html).join("");
  await waitForImages(measurer);
  alignSplitRows(measurer);
  const containerTop = measurer.getBoundingClientRect().top;
  const bottoms = Array.from(measurer.children).map((el) => el.getBoundingClientRect().bottom - containerTop);
  measurer.innerHTML = "";
  const heights = bottoms.map((bottom, i) => (i === 0 ? bottom : bottom - bottoms[i - 1]));

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
    if (bundleHeight > USABLE_HEIGHT_PX) {
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

    if (sheetHasContent && (forcedBreak || sheetHeight + bundleHeight > USABLE_HEIGHT_PX)) {
      sheets.push([]);
      sheetHeights.push(sheetHeight);
      sheetHeight = 0;
    }
    for (let k = i; k <= bundleLast; k++) {
      sheets[sheets.length - 1].push(units[k]);
      sheetHeight += heights[k];
    }
    i = bundleLast + 1;
  }
  sheetHeights.push(sheetHeight);

  const leftoverPx = sheetHeights.map((used) => USABLE_HEIGHT_PX - used);
  return { sheets, leftoverPx, oversizedBundle };
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
function flowQuestionRows(b, figPct) {
  const parts = b.parts || [];
  if (!parts.length) return [];
  const figH = figureHeightMm(parts.flatMap((p) => p.figures || []), figPct);
  const cols = flowGridColumns(parts, figH, b.columns || 0);
  const rows = [];
  for (let i = 0; i < parts.length; i += cols) rows.push(parts.slice(i, i + cols));
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
  const wsFor = (p) => p.workingSpace || fallbackWs;
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
  const cols = (b.parts || []).length
    ? sharedFig
      // The left column is only about half the page now, so the parts
      // stack rather than trying to hold the book's own column count.
      ? (b.parts.length > 4 ? 2 : 1)
      : flowGridColumns(b.parts, partFigH, b.columns || 0)
    : 0;
  // A slice renders only some of the parts, so a tall grid can be split
  // over a page break. `head` carries the number, stem and shared
  // diagrams; the rest carry grid rows only.
  const shown = slice ? slice.parts : b.parts || [];
  const head = !slice || slice.head;
  const parts = shown.length
    ? `<div class="flowq-grid" style="grid-template-columns:repeat(${cols},1fr)">` +
      shown
        .map(
          (p) =>
            `<div class="flowq-cell">` +
            `<div class="flowq-cell-head"><span class="flowq-letter">${escapeHtml(p.letter)}</span>` +
            `<span class="flowq-ptext">${flowRunsHtml(p.content, cropsBaseUrl)}</span></div>` +
            // The part's own diagram comes BEFORE its sub-items: it is
            // what they are answered against, so printing it after
            // them left it stranded under a column of answer boxes
            // with nothing to say which question it belonged to.
            ((p.figures || []).length ? `<div class="flowq-cell-fig">${partFig(p)}</div>` : "") +
            // Roman sub-items keep their own line and their own marker,
            // as the book sets them. Run together into the part's own
            // sentence they read as one impossible instruction.
            ((p.subs || []).length
              ? `<div class="flowq-subs">` +
                p.subs
                  .map(
                    (s) =>
                      `<div class="flowq-sub"><span class="flowq-subletter">${escapeHtml(s.letter)}</span>` +
                      `<span class="flowq-ptext">${flowRunsHtml(s.content, cropsBaseUrl)}</span></div>` +
                      (s.workingSpace ? workingSpaceHtml(s.workingSpace) : "")
                  )
                  .join("") +
                `</div>`
              : "") +
            workingSpaceHtml(wsFor(p)) +
            `</div>`
        )
        .join("") +
      `</div>`
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
  const figMm = sharedFig ? Math.max(38, Math.min(78, (b.figures[0].wMm * figPct) / 100)) : 0;
  const splitHtml = () =>
    `<div class="flowq-split">` +
    `<div class="flowq-split-main">${parts}</div>` +
    `<div class="flowq-split-fig" style="flex:0 0 ${figMm.toFixed(0)}mm">${figBlock}</div>` +
    `</div>`;
  // The answer space sits OUTSIDE the row, so it spans the full content
  // width for every question. Inside the row it inherited whatever was
  // left after the figure column, so a question with a photo beside it
  // got a visibly narrower grid than the one above - the ragged,
  // stepped look of a page of mixed questions.
  return (
    `<div class="flowq-unit">` +
    `<div class="flowq-row">` +
    `<div class="flowq-num">${head ? escapeHtml(b.number || "") : ""}</div>` +
    `<div class="flowq-body">` +
    (head ? stem : "") +
    (sharedFig ? splitHtml() : (head ? contextFig : "") + parts) +
    (head && !contextFig && many ? figBlock : "") +
    `</div>` +
    (head && !contextFig && !many ? figBlock : "") +
    `</div>` +
    // Parts bring their own boxes, so the whole-question box is only
    // for a question that has no parts at all - otherwise every
    // multi-part question ended with a second, unusable spare box.
    (head && !(b.parts || []).length ? workingSpaceHtml(ws) : "") +
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

function gridBoxHtml(height, spacing) {
  let inner = "";
  for (let x = spacing; x < BOX_WIDTH_MM; x += spacing) {
    inner += `<div class="grid-line-v" style="left:${x}mm"></div>`;
  }
  for (let y = spacing; y < height; y += spacing) {
    inner += `<div class="grid-line-h" style="top:${y}mm"></div>`;
  }
  return `<div class="working-space" style="height:${height}mm">${inner}</div>`;
}

function workingSpaceHtml(ws) {
  if (ws.style === "none") return "";
  const spacing = ws.style === "lines" ? RULE_MM : GRID_MM;
  const height = snapDown(ws.heightMm, spacing);
  if (ws.style === "grid") return gridBoxHtml(height, spacing);
  if (ws.columns === 2) {
    const col = `<div class="working-space" style="height:${height}mm">${ruleLinesHtml(height, spacing)}</div>`;
    return `<div class="working-space-row">${col}${col}</div>`;
  }
  return `<div class="working-space" style="height:${height}mm">${ruleLinesHtml(height, spacing)}</div>`;
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
    const html = `<div class="group">${crop}${workingSpaceHtml(ws)}${hangingControls}</div>`;
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
    return `<div class="${cls}"${kindAttr(b)}>${crop}${workingSpaceHtml(b.workingSpace)}</div>`;
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
          const rows = flowQuestionRows(b, figPct);
          if (rows.length > 2 && rows[0].length > 1) {
            rows.forEach((rowParts, ri) => {
              const slice = { parts: rowParts, head: ri === 0 };
              const rowHtml = flowQuestionHtml(b, cropsBaseUrl, ws, figPct, slice);
              units.push({
                html: `<div class="block question flowq${ri ? " flowq-cont" : ""}">${rowHtml}${ri === 0 ? controls : ""}</div>`,
                heading: false,
                wsTargets: ri === 0
                  ? [{ kind: "block", id: b.id, canShrink: canShrink(b, defaultScales.combined) }]
                  : [],
                breakBefore: ri === 0 ? !!b.breakBefore : false,
                glueForward: ri === 0,
              });
            });
            return;
          }
          const html = flowQuestionHtml(b, cropsBaseUrl, ws, figPct) + controls;
          units.push({
            html: `<div class="block question flowq">${html}</div>`,
            heading: false,
            wsTargets: [{ kind: "block", id: b.id, canShrink: canShrink(b, defaultScales.combined) }],
            breakBefore: !!b.breakBefore,
            pairData: { id: b.id, crop: flowQuestionHtml(b, cropsBaseUrl, ws, figPct), ws, pct: figPct, breakBefore: !!b.breakBefore, wantsPair: !!b.pairWithNext },
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
          const pct =
            b.imageScale ??
            (b.section ? defaultScales.section : b.answers ? defaultScales.answers : defaultScales.combined);
          const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm, pct, b.manualCropSrc);
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
          const pct = b.imageScale ?? defaultScales.combined;
          const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm, pct, b.manualCropSrc);
          const hangingControls = controlsHangHtml(b.id, renderQuestionControls(b.id, "block", b.workingSpace, pct, b.breakBefore) + pairWithNextControlHtml(b.id, !!b.pairWithNext) + deleteButtonHtml(b.id, "block", "Delete question") + cropButtonHtml(b.id, "block"));
          const html = `<div class="block question"${kindAttr(b)}>${crop}${workingSpaceHtml(b.workingSpace)}${hangingControls}</div>`;
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
          questionHtml.push(`<div class="block question">${qCrop}${workingSpaceHtml(qb.workingSpace)}${qControls}</div>`);
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
        const combPct = combB.imageScale ?? defaultScales.combined;
        const combCrop = cropHtml(cropsBaseUrl, combB.id, combB.contextImage, combB.widthMm, combPct, combB.manualCropSrc);
        const combControls = controlsHangHtml(
          combB.id,
          imageScaleControlHtml(combB.id, "block", combPct) + breakBeforeControlHtml(combB.id, "block", combB.breakBefore) + cropButtonHtml(combB.id, "block")
        );
        const solPct = solB.imageScale ?? defaultScales.combined;
        const solCrop = cropHtml(cropsBaseUrl, solB.id, solB.contextImage, solB.widthMm, solPct, solB.manualCropSrc);
        const blankWs = { style: solB.blankStyle || "grid", heightMm: solB.blankHeightMm || 20 };
        const solControls = controlsHangHtml(
          solB.id,
          imageScaleControlHtml(solB.id, "block", solPct) + breakBeforeControlHtml(solB.id, "block", solB.breakBefore) + cropButtonHtml(solB.id, "block")
        );
        const expPct = expB.imageScale ?? defaultScales.combined;
        const expCrop = cropHtml(cropsBaseUrl, expB.id, expB.contextImage, expB.widthMm, expPct, expB.manualCropSrc);
        const expControls = controlsHangHtml(
          expB.id,
          imageScaleControlHtml(expB.id, "block", expPct) + breakBeforeControlHtml(expB.id, "block", expB.breakBefore) + cropButtonHtml(expB.id, "block")
        );
        const html =
          `<div class="workthrough-unit">` +
          `<div class="workthrough-combined">${combCrop}${combControls}</div>` +
          `<div class="workthrough-split"><div class="workthrough-row">` +
          `<div class="workthrough-solution">` +
          `<div class="teacher-solution-crop">${solCrop}</div>` +
          `<div class="teacher-solution-blank">${workingSpaceHtml(blankWs)}</div>` +
          `${solControls}</div>` +
          `<div class="workthrough-explanation">${expCrop}${expControls}</div>` +
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
        units.push({ html, heading: false, wsTargets, breakBefore: !!combB.breakBefore, glueForward: !!combB.glueForward });
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

  const spreads = [];
  for (let i = 0; i < physicalPagesHtml.length; i += 2) {
    spreads.push(`<div class="spread">${physicalPagesHtml.slice(i, i + 2).join("")}</div>`);
  }
  return flowStyle ? `<div${flowStyle}>${spreads.join("")}</div>` : spreads.join("");
}
