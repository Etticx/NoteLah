const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function beforePack(context) {
  // Run for direct electron-builder invocations as well as npm packaging scripts.
  execFileSync(process.execPath, [path.join(__dirname, "generate-licenses.mjs")], {
    cwd: context.packager.projectDir,
    stdio: "inherit",
  });
};
