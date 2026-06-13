#!/usr/bin/env node
// set-area-field.mjs — populate the board's "Area" single-select field from each item's `area:` label.
// (Labels can't be grouped/sliced in GitHub Projects — only single-select fields can — so this mirrors
// the area: labels into a real field for the "By Area" view.) Idempotent: re-setting the same value is a no-op.
//
// Usage: node tools/board/set-area-field.mjs

import { execFileSync } from "node:child_process";

const OWNER = "stoopkid713";
const gh = (a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const ghJSON = (a) => JSON.parse(gh(a));

const projectId = ghJSON(["project", "view", "1", "--owner", OWNER, "--format", "json"]).id;
const areaField = ghJSON(["project", "field-list", "1", "--owner", OWNER, "--format", "json"])
  .fields.find((f) => f.name === "Area");
if (!areaField) throw new Error("Area field not found — create it first");
const optId = (name) => areaField.options.find((o) => o.name === name)?.id;

const items = ghJSON(["project", "item-list", "1", "--owner", OWNER, "--format", "json", "--limit", "300"]).items;

let set = 0, skip = 0;
for (const it of items) {
  const area = (it.labels || []).find((l) => l.startsWith("area:"))?.slice("area:".length);
  const oid = area && optId(area);
  if (!oid) { console.log("no area label:", it.title); skip++; continue; }
  gh(["project", "item-edit", "--id", it.id, "--project-id", projectId,
    "--field-id", areaField.id, "--single-select-option-id", oid]);
  set++;
}
console.log(`\ndone: ${set} set, ${skip} skipped`);
