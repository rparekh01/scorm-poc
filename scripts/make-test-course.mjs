// Builds a tiny SCORM 1.2 course. Writes:
//   test-course/demo-course.zip      -> upload this to the zips bucket to test the real pipeline
//   local-data/demo-course/...       -> pre-extracted copy, for running the app without GCP
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const id = process.argv[2] ?? "demo-course";
const src = path.resolve("test-course/src");
rmSync(src, { recursive: true, force: true });
mkdirSync(src, { recursive: true });

writeFileSync(path.join(src, "imsmanifest.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="demo" version="1" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org1">
    <organization identifier="org1">
      <title>Demo Course</title>
      <item identifier="item1" identifierref="res1"><title>Demo Course</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res1" type="webcontent" adlcp:scormtype="sco" href="content/index.html">
      <file href="content/index.html"/><file href="content/scripts/app.js"/>
    </resource>
  </resources>
</manifest>`);

mkdirSync(path.join(src, "content/scripts"), { recursive: true });
writeFileSync(path.join(src, "content/index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo Course</title></head>
<body style="font-family:sans-serif;padding:16px">
<h2>Demo SCORM 1.2 course</h2>
<p id="status">Looking for the LMS API…</p>
<button id="done">Complete course</button>
<script src="scripts/app.js"></script>
</body></html>`);

writeFileSync(path.join(src, "content/scripts/app.js"), `
function findAPI(win) {
  for (let i = 0; i < 10 && win; i++) {
    try { if (win.API) return win.API; } catch (e) { return null; } // cross-origin = blocked
    if (win === win.parent) break;
    win = win.parent;
  }
  return null;
}
const api = findAPI(window);
const status = document.getElementById("status");
if (!api) { status.textContent = "LMS API NOT FOUND (cross-origin or missing)"; }
else {
  api.LMSInitialize("");
  status.textContent = "LMS API found. Session started.";
  api.LMSSetValue("cmi.core.lesson_status", "incomplete");
  api.LMSCommit("");
  document.getElementById("done").onclick = () => {
    api.LMSSetValue("cmi.core.score.raw", "100");
    api.LMSSetValue("cmi.core.lesson_status", "completed");
    api.LMSCommit("");
    api.LMSFinish("");
    status.textContent = "Course completed and reported.";
  };
}`);

execFileSync("zip", ["-qr", path.resolve("test-course", `${id}.zip`), "."], { cwd: src });
const hash = createHash("sha256").update(id + Date.now()).digest("hex").slice(0, 12);
const out = path.resolve("local-data", id);
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, hash), { recursive: true });
execFileSync("cp", ["-r", ...["imsmanifest.xml", "content"].map((f) => path.join(src, f)), path.join(out, hash)]);
writeFileSync(path.join(out, "manifest.json"), JSON.stringify({
  builderId: id, version: hash, launchPath: "content/index.html", scormVersion: "1.2",
  title: "Demo Course", extractedAt: new Date().toISOString(),
}, null, 2));
console.log(`Wrote local-data/${id}/ (version ${hash}) and test-course/${id}.zip`);
