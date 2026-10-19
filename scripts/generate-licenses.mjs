import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const output = [
  "NoteLah third-party licence text collection",
  "Generated from installed packages in package-lock.json. Includes development tools.",
  "Third-party material retains its original licence; NoteLah's MIT licence does not replace it.",
  "Missing texts and licence compatibility require manual review. This is not a compliance certification.",
];
const missing = [];
let packages = 0;
let texts = 0;

async function collect(directory, prefix = "") {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const relative = prefix + entry.name;
    // Nested installed packages have their own lockfile entries. Never follow symlinks.
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      found.push(...await collect(path.join(directory, entry.name), relative + "/"));
    } else if (entry.isFile() && /^(?:licen[cs]es?|notices?|copying|copyright|ofl)(?:[._-]|$)/i.test(entry.name)
      && (!path.extname(entry.name) || /\.(?:txt|md|html?|rst)$/i.test(entry.name))) {
      found.push({ relative, text: await readFile(path.join(directory, entry.name), "utf8") });
    }
  }
  return found;
}

for (const [relative, metadata] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, "en"))) {
  if (!relative || !relative.startsWith("node_modules/")) continue;
  const directory = path.resolve(root, relative);
  if (!directory.startsWith(root + path.sep)) throw new Error("Package path escaped repository");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  } catch (error) {
    // Platform-specific optional packages may not be installed on this machine.
    if (error.code === "ENOENT" && metadata.optional) continue;
    throw error;
  }
  const files = await collect(directory);
  packages++;
  output.push(`\n${"=".repeat(80)}\n${manifest.name}@${manifest.version}\nPath: ${relative}\nDeclared licence: ${JSON.stringify(manifest.license ?? metadata.license ?? "UNDECLARED")}`);
  if (!files.length) {
    missing.push(`${manifest.name}@${manifest.version}`);
    output.push("NO LICENCE TEXT COLLECTED: inspect upstream terms before distributing this component.");
  }
  for (const file of files) {
    output.push(`\n--- ${relative}/${file.relative} ---\n${file.text}`);
    texts++;
  }
}

output.push(`\nManual review: ${missing.length ? missing.join(", ") : "No installed packages without collected text."}\n`);
await writeFile(path.join(root, "THIRD_PARTY_LICENSES.txt"), output.join("\n"), "utf8");
console.log(`Collected ${texts} licence/notice files from ${packages} installed packages into THIRD_PARTY_LICENSES.txt.`);
if (missing.length) console.warn(`Manual review needed (${missing.length} packages without text): ${missing.join(", ")}`);
