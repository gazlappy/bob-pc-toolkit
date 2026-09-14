'use strict';

// Builds the size tree behind the treemap view.
//
// The whole tree is kept here in the main process — a folder like a synced
// OneDrive Desktop can hold well over a hundred thousand files, and shipping
// all of that to the renderer would be tens of megabytes of JSON. Instead the
// renderer asks for one node at a time and gets back a pruned view: the
// children that are big enough to be worth drawing, a few levels deep, with
// everything too small to see rolled into a single "smaller items" block.

const path = require('path');
const walker = require('./walk');
const files = require('./files');

const MAX_FILES = 400000;

// How much of its parent a child must be worth before it is drawn separately.
// The share is measured against the immediate parent, not the whole tree, so
// small folders still show their contents.
//
// Depth matters more than it looks: at three levels the view stopped at the
// folders and never reached the files inside them, so the map rendered as a
// grid of empty boxes. Six levels fills them in; MAX_NODES below is what keeps
// that from turning into an unbounded payload.
const MIN_SHARE = 0.0015;
const MAX_CHILDREN = 120;
const VIEW_DEPTH = 6;

// A hard ceiling on how many nodes one view may hold, so the payload stays
// predictable however large or deeply nested the folder turns out to be.
const MAX_NODES = 12000;

let tree = null;
let index = new Map();

function makeNode(name, fullPath, isDir) {
  return { name, path: fullPath, dir: isDir, bytes: 0, files: 0, children: isDir ? [] : null };
}

/** Sums sizes bottom-up and sorts every child list largest-first. */
function finalise(node) {
  if (!node.dir) return node;
  let bytes = 0;
  let count = 0;
  for (const child of node.children) {
    finalise(child);
    bytes += child.bytes;
    count += child.files;
  }
  node.bytes = bytes;
  node.files = count;
  node.children.sort((a, b) => b.bytes - a.bytes);
  return node;
}

async function scan({ rootIds = [], minBytes = 0, olderThanDays = 0 } = {}, onProgress) {
  const roots = (await files.availableRoots()).filter((root) => rootIds.includes(root.id));
  if (!roots.length) throw new Error('Pick at least one folder to map.');

  const cutoff = olderThanDays > 0 ? Date.now() - olderThanDays * 86400000 : null;

  const root = makeNode('Selected folders', '::selected-folders', true);
  index = new Map([[root.path, root]]);

  let seen = 0;
  let matched = 0;
  let lastReport = 0;
  let truncated = false;

  for (const rootInfo of roots) {
    const rootNode = makeNode(rootInfo.label, rootInfo.path, true);
    root.children.push(rootNode);
    index.set(rootNode.path.toLowerCase(), rootNode);

    // Directory nodes are created on demand as files arrive, walking up to the
    // root so that intermediate folders exist even if they hold no files
    // directly.
    const dirFor = (dir) => {
      const key = dir.toLowerCase();
      const found = index.get(key);
      if (found) return found;

      const parentPath = path.dirname(dir);
      // Guard against a malformed path walking past the root forever.
      const parent = parentPath === dir ? rootNode : dirFor(parentPath);
      const node = makeNode(path.basename(dir) || dir, dir, true);
      parent.children.push(node);
      index.set(key, node);
      return node;
    };

    const outcome = await walker.walk(
      rootInfo.path,
      (full, stats, dir) => {
        if (seen >= MAX_FILES) {
          truncated = true;
          return;
        }
        seen += 1;

        if (onProgress && seen - lastReport >= 2000) {
          lastReport = seen;
          onProgress({ seen, matched, folder: dir });
        }

        // The same filters the list view uses. Folders whose files are all
        // filtered out never get created, so they drop off the map entirely.
        if (stats.size < minBytes) return;
        if (cutoff !== null && Math.max(stats.mtimeMs, stats.atimeMs) > cutoff) return;

        matched += 1;
        const parent = dir.toLowerCase() === rootInfo.path.toLowerCase() ? rootNode : dirFor(dir);
        const node = makeNode(path.basename(full), full, false);
        node.bytes = stats.size;
        node.files = 1;
        parent.children.push(node);
      },
      { maxEntries: MAX_FILES * 2 }
    );

    if (outcome.truncated) truncated = true;
  }

  finalise(root);
  tree = root;

  // Wrapping a single folder in a "Selected folders" container just burns a
  // level of nesting. Roots that turned out to be empty do not count, so
  // picking Downloads (empty) alongside Desktop still opens straight into
  // Desktop rather than a container holding one visible child.
  const withContent = root.children.filter((child) => child.bytes > 0);
  const start = withContent.length === 1 ? withContent[0] : root;

  return {
    totalBytes: root.bytes,
    totalFiles: root.files,
    scannedFiles: seen,
    matchedFiles: matched,
    filtered: minBytes > 0 || olderThanDays > 0,
    truncated,
    root: viewOf(start),
  };
}

/**
 * A node's full path is nearly all redundant — it is its parent's path plus its
 * own name — and repeating it on every node was two thirds of the payload. Only
 * the view root and its immediate children carry one (the children because the
 * root may be the synthetic "Selected folders" container, whose path cannot be
 * joined onto). The renderer rebuilds the rest by walking down from the root.
 */
function shallow(node, withPath) {
  const out = {
    name: node.name,
    dir: node.dir,
    bytes: node.bytes,
    files: node.files,
    ext: node.dir ? null : path.extname(node.name).slice(1).toLowerCase(),
  };
  if (withPath) out.path = node.path;
  return out;
}

/**
 * Prunes a node into something small enough to send and draw.
 *
 * Expansion is breadth-first and capped at MAX_NODES. Depth-first would let one
 * deeply-nested branch spend the whole budget before its siblings were looked
 * at; going level by level means the shallow tiles — the ones actually big
 * enough to see — always get their detail, and only the deepest, smallest
 * nesting is dropped when the budget runs out.
 */
function viewOf(node) {
  const root = shallow(node, true);
  let frontier = [{ src: node, dst: root, depth: 0 }];
  let budget = MAX_NODES;

  while (frontier.length && budget > 0) {
    const next = [];

    for (const { src, dst, depth } of frontier) {
      // Stop mid-level once spent; the remaining folders simply stay leaves,
      // which still carry their correct size.
      if (budget <= 0) break;
      if (!src.dir || depth >= VIEW_DEPTH || !src.children.length) continue;

      const kept = [];
      let restBytes = 0;
      let restFiles = 0;
      let restCount = 0;

      for (const child of src.children) {
        const bigEnough = src.bytes > 0 && child.bytes / src.bytes >= MIN_SHARE;
        if (kept.length < MAX_CHILDREN && bigEnough && child.bytes > 0 && budget > 0) {
          const view = shallow(child, depth === 0);
          kept.push(view);
          budget -= 1;
          if (child.dir) next.push({ src: child, dst: view, depth: depth + 1 });
        } else {
          restBytes += child.bytes;
          restFiles += child.files;
          restCount += 1;
        }
      }

      dst.children = kept;
      if (restCount > 0 && restBytes > 0) {
        dst.children.push({
          name: `${restCount.toLocaleString('en-GB')} smaller item${restCount === 1 ? '' : 's'}`,
          dir: false,
          aggregate: true,
          bytes: restBytes,
          files: restFiles,
          ext: null,
        });
        // Counted too, or a tree full of pruned folders sails past the ceiling.
        budget -= 1;
      }
    }

    frontier = next;
  }

  return root;
}

/** The pruned view for one folder, used when zooming in. */
function node(targetPath) {
  if (!tree) throw new Error('Run a scan first.');
  const found =
    targetPath === tree.path ? tree : index.get(String(targetPath).toLowerCase());
  if (!found) throw new Error('That folder is no longer in the scan. Scan again.');
  return viewOf(found);
}

/** Ancestors of a path, for the breadcrumb trail. */
function trail(targetPath) {
  if (!tree) return [];
  const crumbs = [];
  let current = index.get(String(targetPath).toLowerCase()) || (targetPath === tree.path ? tree : null);

  while (current) {
    crumbs.unshift({ name: current.name, path: current.path, bytes: current.bytes });
    if (current === tree) break;
    const parentPath = path.dirname(current.path);
    const parent =
      index.get(parentPath.toLowerCase()) ||
      (tree.children.includes(current) ? tree : null);
    if (!parent || parent === current) {
      if (tree.children.length > 1 && current !== tree) crumbs.unshift({ name: tree.name, path: tree.path, bytes: tree.bytes });
      break;
    }
    current = parent;
  }

  return crumbs;
}

function reset() {
  tree = null;
  index = new Map();
}

module.exports = { scan, node, trail, reset };
