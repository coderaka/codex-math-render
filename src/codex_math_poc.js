import * as katexBundle from "./katex-BOMIA_qf.js";

const STYLE_ID = "codex-math-poc-style";
const RENDERED_ATTR = "data-codex-math-rendered";
const SNAPSHOT_PROP = Symbol("codexMathSnapshot");
const STREAM_SETTLE_MS = 180;

const MATH_HINT = /\$\$|\$(?!\s)([^$\n]+?)\$/;
const DISPLAY_ONLY_RE = /^\s*\$\$\s*([\s\S]*?)\s*\$\$\s*$/;
const MAX_FLATTEN_TEXT_LENGTH = 500;

const DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "$", right: "$", display: false }
];

const FLATTENABLE_TAGS = new Set(["DIV", "P", "SPAN", "LI"]);
const FLATTENABLE_DESCENDANTS = new Set([
  "DIV",
  "P",
  "SPAN",
  "STRONG",
  "EM",
  "B",
  "I",
  "U",
  "S",
  "SMALL",
  "MARK",
  "SUB",
  "SUP",
  "DEL",
  "INS",
  "BR"
]);

const SKIP_SELECTOR = [
  "pre",
  "code",
  "input",
  "textarea",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "script",
  "style",
  "a",
  ".katex",
  ".katex-display",
  ".math-rendered-inline",
  ".math-rendered-display"
].join(",");

function resolveKatexApi(bundle) {
  if (bundle && typeof bundle.render === "function") {
    return bundle;
  }

  for (const value of Object.values(bundle)) {
    if (value && typeof value === "object" && typeof value.render === "function") {
      return value;
    }
  }

  throw new Error("Could not resolve KaTeX API from bundled module.");
}

const katex = resolveKatexApi(katexBundle);

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .math-rendered-display {
      display: block;
      text-align: center;
      margin: 0.8em 0;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 0.15rem 0;
    }

    .math-rendered-inline {
      display: inline;
    }
  `;
  document.head.appendChild(style);
}

function isEditableEditor(node) {
  if (!node) {
    return false;
  }

  const lexicalRoot = node.closest("[data-lexical-editor]");
  if (lexicalRoot) {
    const contentEditable = lexicalRoot.getAttribute("contenteditable");
    const role = lexicalRoot.getAttribute("role");
    if (lexicalRoot.isContentEditable || contentEditable === "" || contentEditable === "true" || role === "textbox") {
      return true;
    }
  }

  const proseMirrorRoot = node.closest(".ProseMirror");
  if (proseMirrorRoot) {
    const contentEditable = proseMirrorRoot.getAttribute("contenteditable");
    if (proseMirrorRoot.isContentEditable || contentEditable === "" || contentEditable === "true") {
      return true;
    }
  }

  return false;
}

function shouldSkipElement(node) {
  return !node || Boolean(node.closest(SKIP_SELECTOR)) || isEditableEditor(node);
}

function shouldSkipText(node) {
  const parent = node.parentElement;
  return !parent || shouldSkipElement(parent);
}

function isEscaped(text, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function hasUnescapedDollar(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "$" && !isEscaped(text, index)) {
      return true;
    }
  }

  return false;
}

function findOpen(text, position) {
  let best = null;

  for (const delimiter of DELIMITERS) {
    const index = text.indexOf(delimiter.left, position);
    if (index === -1 || isEscaped(text, index)) {
      continue;
    }

    if (delimiter.left === "$" && text[index + 1] && /\s/.test(text[index + 1])) {
      continue;
    }

    if (
      !best ||
      index < best.index ||
      (index === best.index && delimiter.left.length > best.delimiter.left.length)
    ) {
      best = { index, delimiter };
    }
  }

  return best;
}

function findClose(text, start, delimiter) {
  let index = text.indexOf(delimiter.right, start);

  while (index !== -1) {
    if (!isEscaped(text, index)) {
      if (delimiter.right === "$") {
        if (text[index - 1] && /\s/.test(text[index - 1])) {
          index = text.indexOf(delimiter.right, index + 1);
          continue;
        }

        if (text[index + 1] === "$") {
          index = text.indexOf(delimiter.right, index + 1);
          continue;
        }
      }

      return index;
    }

    index = text.indexOf(delimiter.right, index + delimiter.right.length);
  }

  return -1;
}

function isValidMathCandidate(body, delimiter) {
  if (!body.trim()) {
    return false;
  }

  if (delimiter.left === "$" && delimiter.right === "$" && hasUnescapedDollar(body)) {
    return false;
  }

  return true;
}

function tokenize(text) {
  const tokens = [];
  let position = 0;

  while (position < text.length) {
    const open = findOpen(text, position);
    if (!open) {
      tokens.push({ type: "text", data: text.slice(position) });
      break;
    }

    if (open.index > position) {
      tokens.push({ type: "text", data: text.slice(position, open.index) });
    }

    const mathStart = open.index + open.delimiter.left.length;
    const closeIndex = findClose(text, mathStart, open.delimiter);

    if (closeIndex === -1) {
      tokens.push({ type: "text", data: text.slice(open.index) });
      break;
    }

    const body = text.slice(mathStart, closeIndex);
    if (!isValidMathCandidate(body, open.delimiter)) {
      tokens.push({
        type: "text",
        data: text.slice(open.index, open.index + open.delimiter.left.length)
      });
      position = open.index + open.delimiter.left.length;
      continue;
    }

    tokens.push({
      type: "math",
      data: body,
      display: open.delimiter.display,
      rawLeft: open.delimiter.left,
      rawRight: open.delimiter.right
    });

    position = closeIndex + open.delimiter.right.length;
  }

  return tokens;
}

function extractWithMarkers(node) {
  let result = "";

  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent || "";
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const tag = child.tagName.toLowerCase();
    if (tag === "em") {
      result += `_${extractWithMarkers(child)}_`;
    } else if (tag === "strong") {
      result += `__${extractWithMarkers(child)}__`;
    } else {
      result += child.textContent || "";
    }
  }

  return result;
}

function restoreUnderscores(element) {
  if (!element || shouldSkipElement(element)) {
    return;
  }

  let restored = false;
  let segment = [];

  function flush() {
    if (!segment.length) {
      return;
    }

    const hasFormatting = segment.some((unit) => unit.type === "format");
    if (!hasFormatting) {
      segment = [];
      return;
    }

    let merged = "";
    let cursor = 0;
    for (const unit of segment) {
      unit.start = cursor;
      merged += unit.text;
      cursor += unit.text.length;
      unit.end = cursor;
    }

    if (!merged.includes("$")) {
      segment = [];
      return;
    }

    const ranges = [];
    let position = 0;
    while (position < merged.length) {
      const open = findOpen(merged, position);
      if (!open) {
        break;
      }

      const start = open.index + open.delimiter.left.length;
      const close = findClose(merged, start, open.delimiter);
      if (close === -1) {
        position = start;
        continue;
      }

      ranges.push({ start, end: close });
      position = close + open.delimiter.right.length;
    }

    if (!ranges.length) {
      segment = [];
      return;
    }

    for (const unit of segment) {
      if (unit.type !== "format") {
        continue;
      }

      const touchesMath = ranges.some(
        (range) =>
          (unit.start >= range.start && unit.start < range.end) ||
          (unit.end > range.start && unit.end <= range.end)
      );

      if (!touchesMath) {
        continue;
      }

      unit.node.replaceWith(document.createTextNode(`${unit.marker}${unit.text}${unit.marker}`));
      restored = true;
    }

    segment = [];
  }

  for (const child of [...element.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (shouldSkipText(child)) {
        flush();
        continue;
      }

      const text = child.textContent || "";
      if (!text) {
        flush();
        continue;
      }

      segment.push({ type: "text", text });
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      flush();
      continue;
    }

    if (shouldSkipElement(child)) {
      flush();
      continue;
    }

    const tag = child.tagName.toLowerCase();
    if (tag === "em" || tag === "strong") {
      const text = extractWithMarkers(child);
      if (!text) {
        flush();
        continue;
      }

      segment.push({
        type: "format",
        node: child,
        text,
        marker: tag === "strong" ? "__" : "_"
      });
      continue;
    }

    flush();
    restoreUnderscores(child);
  }

  flush();

  if (restored) {
    element.normalize();
  }
}

function renderMathToken(token) {
  const span = document.createElement("span");
  span.className = token.display ? "math-rendered-display" : "math-rendered-inline";

  try {
    katex.render(token.data.trim(), span, {
      displayMode: token.display,
      throwOnError: false,
      trust: true
    });
  } catch {
    span.textContent = `${token.rawLeft}${token.data}${token.rawRight}`;
  }

  return span;
}

function renderTokensToFragment(tokens) {
  const fragment = document.createDocumentFragment();

  for (const token of tokens) {
    if (token.type === "text") {
      if (token.data) {
        fragment.appendChild(document.createTextNode(token.data));
      }
      continue;
    }

    fragment.appendChild(renderMathToken(token));
  }

  return fragment;
}

function getNodeDepth(node) {
  let depth = 0;
  let current = node;

  while (current && current.parentElement) {
    depth += 1;
    current = current.parentElement;
  }

  return depth;
}

function isFlattenableContainer(element) {
  if (
    !element ||
    !FLATTENABLE_TAGS.has(element.tagName) ||
    element.hasAttribute(RENDERED_ATTR) ||
    shouldSkipElement(element)
  ) {
    return false;
  }

  const text = (element.textContent || "").replace(/\u200b/g, "");
  if (!text || text.length > MAX_FLATTEN_TEXT_LENGTH || !MATH_HINT.test(text)) {
    return false;
  }

  const descendants = element.querySelectorAll("*");
  if (descendants.length === 0 || descendants.length > 24) {
    return false;
  }

  for (const descendant of descendants) {
    if (
      descendant !== element &&
      (!FLATTENABLE_DESCENDANTS.has(descendant.tagName) || shouldSkipElement(descendant))
    ) {
      return false;
    }
  }

  return true;
}

function renderFlattenableContainers(root) {
  const candidates = [];
  if (isFlattenableContainer(root)) {
    candidates.push(root);
  }

  for (const element of root.querySelectorAll("div, p, span, li")) {
    if (isFlattenableContainer(element)) {
      candidates.push(element);
    }
  }

  candidates.sort((left, right) => {
    const depthLeft = getNodeDepth(left);
    const depthRight = getNodeDepth(right);
    return depthRight - depthLeft;
  });

  const rendered = [];

  for (const element of candidates) {
    if (rendered.some((child) => element.contains(child))) {
      continue;
    }

    const tokens = tokenize((element.textContent || "").replace(/\u200b/g, ""));
    if (tokens.length === 1 && tokens[0].type === "text") {
      continue;
    }

    element.replaceChildren(renderTokensToFragment(tokens));
    rendered.push(element);
  }

  return rendered.length > 0;
}

function tryRenderDisplayContainer(element) {
  if (element.hasAttribute(RENDERED_ATTR) || shouldSkipElement(element)) {
    return false;
  }

  const text = (element.textContent || "").replace(/\u200b/g, "");
  const match = text.match(DISPLAY_ONLY_RE);
  if (!match) {
    return false;
  }

  const latex = match[1].trim();
  if (!latex) {
    return false;
  }

  element.textContent = "";
  element.appendChild(renderMathToken({ data: latex, display: true, rawLeft: "$$", rawRight: "$$" }));
  element.setAttribute(RENDERED_ATTR, "1");
  element[SNAPSHOT_PROP] = element.textContent || "";
  return true;
}

function renderTextNodes(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node = null;

  while ((node = walker.nextNode())) {
    if (shouldSkipText(node)) {
      continue;
    }

    const text = node.textContent || "";
    if (!text || !MATH_HINT.test(text)) {
      continue;
    }

    textNodes.push(node);
  }

  let changed = false;

  for (const textNode of textNodes) {
    const tokens = tokenize(textNode.textContent || "");
    if (tokens.length === 1 && tokens[0].type === "text") {
      continue;
    }

    textNode.replaceWith(renderTokensToFragment(tokens));
    changed = true;
  }

  return changed;
}

function processNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  if (shouldSkipElement(node)) {
    return;
  }

  restoreUnderscores(node);
  node.normalize();

  const text = node.textContent || "";
  if (!text || !MATH_HINT.test(text)) {
    return;
  }

  if (node.hasAttribute(RENDERED_ATTR) && node[SNAPSHOT_PROP] === text) {
    return;
  }

  try {
    if (tryRenderDisplayContainer(node)) {
      return;
    }

    const inlineRendered = renderTextNodes(node) || renderFlattenableContainers(node);
    if (!inlineRendered) {
      return;
    }

    node.setAttribute(RENDERED_ATTR, "1");
    node[SNAPSHOT_PROP] = node.textContent || "";
  } catch (error) {
    console.warn("[codex-math-poc] render error:", error);
    node.removeAttribute(RENDERED_ATTR);
  }
}

let observer = null;
let scheduled = false;
let flushTimer = null;
const pending = new Set();

function flushPending() {
  scheduled = false;
  flushTimer = null;
  const nodes = [...pending];
  pending.clear();

  for (const node of nodes) {
    if (node && node.isConnected) {
      processNode(node);
    }
  }
}

function enqueue(node) {
  if (!node) {
    return;
  }

  let target = node;
  if (target.nodeType === Node.TEXT_NODE) {
    target = target.parentElement;
  }

  if (!target || target.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  let current = target;
  let depth = 0;
  while (
    current &&
    current.nodeType === Node.ELEMENT_NODE &&
    current !== document.body &&
    current !== document.documentElement &&
    depth < 4
  ) {
    pending.add(current);
    current = current.parentElement;
    depth += 1;
  }

  if (!scheduled) {
    scheduled = true;
  }

  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
  }

  flushTimer = window.setTimeout(flushPending, STREAM_SETTLE_MS);
}

function startObserver() {
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData" && mutation.target.parentElement) {
        enqueue(mutation.target.parentElement);
      }

      for (const node of mutation.addedNodes) {
        enqueue(node);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function init() {
  ensureStyles();
  startObserver();
  enqueue(document.body);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
