#!/usr/bin/env node
// board-pulse.mjs — at-a-glance readout of the STOOP GitHub Projects board (#1).
//
// One `gh project item-list` query -> counts by Column / Priority / Area / Type, plus the
// actionable "In Progress" and "Next Up" lists. This is the text "board pulse" the tldps skill
// shows on RESUME so you (and Claude) see project state without opening GitHub.
//
// Usage:  node tools/board/board-pulse.mjs
// Requires: gh logged in as stoopkid713 with the `project` scope.

import { execFileSync } from "node:child_process";

const items = JSON.parse(
  execFileSync(
    "gh",
    ["project", "item-list", "1", "--owner", "stoopkid713", "--format", "json", "--limit", "300"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  )
).items;

const STATUS = ["Next Up", "In Progress", "In Review", "Backlog", "Done"];
const PRIORITY = ["Now", "Next", "Later", "Parked"];

const labelVal = (i, prefix) => (i.labels || []).find((l) => l.startsWith(prefix))?.slice(prefix.length) || "—";
const tally = (fn) => {
  const m = {};
  for (const i of items) { const v = fn(i); if (v) m[v] = (m[v] || 0) + 1; }
  return m;
};
const line = (label, m, order) => {
  const keys = order ? order.filter((k) => m[k]) : Object.keys(m).sort((a, b) => m[b] - m[a]);
  return `  ${label}: ` + (keys.map((k) => `${k} ${m[k]}`).join("  ·  ") || "—");
};

console.log(`\n📋 STOOP board  —  https://github.com/users/stoopkid713/projects/1`);
console.log(`   ${items.length} items\n`);
console.log(line("Column  ", tally((i) => i.status || "(none)"), STATUS));
console.log(line("Priority", tally((i) => i.priority || "(none)"), PRIORITY));
console.log(line("Area    ", tally((i) => labelVal(i, "area:"))));
console.log(line("Type    ", tally((i) => labelVal(i, "type:"))));

const show = (title, filter) => {
  const list = items.filter(filter);
  if (!list.length) return;
  console.log(`\n${title} (${list.length}):`);
  for (const i of list) {
    console.log(`  #${i.content?.number}  [${i.priority || "—"}]  ${i.title}  (${labelVal(i, "type:")}/${labelVal(i, "area:")})`);
  }
};
show("🛠️  In Progress", (i) => i.status === "In Progress");
show("🎯 Next Up", (i) => i.status === "Next Up");
console.log("");
