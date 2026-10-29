#!/usr/bin/env node
// Unzips SCORM zips on this computer. With --apply it also uploads them to the bucket.
//
//   node scripts/unzip-local.mjs upload  <zip-or-folder> --bucket gs://<bucket> [--out ./extracted] [--apply]
//   node scripts/unzip-local.mjs replace <zip> --id <N> --bucket gs://<bucket> [--out ./extracted] [--apply]
//
// Without --apply it is a dry run: the zips are unzipped into --out and a plan is printed.
// Nothing is uploaded or deleted in the bucket. The bucket is only read (folder list, manifests).
//
// Output, locally and in the bucket:
//   <id>/manifest.json   { "version": "<upload time>", "courseTitle": "<title>" }   uploaded last
//   <id>/...             the course files, straight from the zip
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { XMLParser } from "fast-xml-parser";

const execFileP = promisify(execFile);

const USAGE = `
Usage:
  node scripts/unzip-local.mjs upload  <zip-or-folder> --bucket gs://<bucket> [--out ./extracted] [--apply]
  node scripts/unzip-local.mjs replace <zip> --id <N> --bucket gs://<bucket> [--out ./extracted] [--apply]

Modes (one is required):
  upload    New course(s). Each zip gets the next free numeric ID: the highest numbered folder in
            the bucket plus one. A folder of zips is numbered in file-name order.
  replace   Re-upload an existing course under the SAME ID. Needs --id and exactly one zip.
            The course must already exist in the bucket.

Dry run is the default. The zips are unzipped into --out (default ./extracted) and a plan is
printed. Nothing is uploaded. Run the same command again with --apply to upload:
  1. (replace only) the old course folder is deleted, so the course is unavailable until step 3
  2. the course files are uploaded
  3. manifest.json is uploaded last, which makes the course available
  4. the upload is checked against your local folder

Other options:
  --bucket gs://<bucket>   Required. Read in a dry run (IDs, existing courses), written with --apply.
  --out <folder>           Where to unzip. Default: ./extracted
`;

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(USAGE);
  process.exit(message ? 1 : 0);
}

// ---- args ----
const argv = process.argv.slice(2);
const flags = { apply: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--apply") flags.apply = true;
  else if (a === "--help" || a === "-h") usage();
  else if (a === "--out" || a === "--bucket" || a === "--id") {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
    flags[a.slice(2)] = v;
  } else if (a.startsWith("--")) usage(`Unknown option ${a}`);
  else positional.push(a);
}

const [mode, input, ...extra] = positional;
if (!mode)
  usage(
    'Say what to do: "upload" (new courses) or "replace" (an existing course).',
  );
if (mode !== "upload" && mode !== "replace")
  usage(`Unknown mode "${mode}". Use "upload" or "replace".`);
if (!input || extra.length)
  usage(
    mode === "upload"
      ? "Give one zip file or one folder of zips."
      : "Give exactly one zip file.",
  );
if (!flags.bucket || !/^gs:\/\/[^/]+\/?$/.test(flags.bucket))
  usage("--bucket gs://<bucket> is required.");
if (mode === "upload" && flags.id !== undefined) {
  usage(
    '"upload" assigns IDs itself. To upload over an existing course, use: replace <zip> --id <N>',
  );
}
if (mode === "replace") {
  if (flags.id === undefined)
    usage('"replace" needs --id <N>, the ID of the course to replace.');
  if (!/^[1-9][0-9]*$/.test(flags.id))
    usage("--id must be a whole number such as 17.");
}
let inputStat;
try {
  inputStat = fs.statSync(input);
} catch {
  usage(`Not found: ${input}`);
}
if (mode === "replace" && !(inputStat.isFile() && /\.zip$/i.test(input))) {
  usage('"replace" takes one .zip file, not a folder.');
}

const BUCKET = flags.bucket.replace(/\/$/, "");
const outDir = path.resolve(flags.out ?? "extracted");
// Files that are never uploaded, and never counted as differences when checking.
const EXCLUDE = "^manifest\\.json$,.*\\.DS_Store$";

const zips = inputStat.isDirectory()
  ? fs
      .readdirSync(input)
      .filter((f) => /\.zip$/i.test(f))
      .sort()
      .map((f) => path.join(input, f))
  : [input];
if (zips.length === 0) usage(`No .zip files found in ${input}`);

// ---- gcloud ----
// Captured output, for reading. Throws with .stderr on a non-zero exit.
function gc(args) {
  const r = spawnSync("gcloud", ["storage", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new Error(`Could not run gcloud: ${r.error.message}`);
  if (r.status !== 0) {
    const err = new Error(
      (r.stderr || "").trim() || `gcloud exited with ${r.status}`,
    );
    err.stderr = r.stderr || "";
    err.out = r.stdout || "";
    throw err;
  }
  return { stdout: r.stdout || "", stderr: r.stderr || "" };
}
// Live output, for uploads and deletes.
const gcRun = (args) =>
  execFileSync("gcloud", ["storage", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
const gcAsync = async (args) =>
  (
    await execFileP("gcloud", ["storage", ...args], {
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;

const NOT_FOUND = /matched no objects|not found|404/i;
// "Not there" is an answer. Any other failure (permissions, network) must stop the run, not look like "not there".
function exists(url) {
  try {
    gc(["ls", url]);
    return true;
  } catch (e) {
    if (NOT_FOUND.test(e.stderr || e.message)) return false;
    throw e;
  }
}
const manifestExists = (id) => exists(`${BUCKET}/${id}/manifest.json`);
const folderExists = (id) => exists(`${BUCKET}/${id}/`);

function listBucketIds() {
  return gc(["ls", `${BUCKET}/`])
    .stdout.split("\n")
    .map((l) => /^gs:\/\/[^/]+\/(\d+)\/$/.exec(l.trim())?.[1])
    .filter(Boolean)
    .map(Number);
}
function readRemoteManifest(id) {
  try {
    return JSON.parse(gc(["cat", `${BUCKET}/${id}/manifest.json`]).stdout);
  } catch {
    return null;
  }
}
async function remoteTitles(ids) {
  const titles = new Map();
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const m = JSON.parse(
          await gcAsync(["cat", `${BUCKET}/${id}/manifest.json`]),
        );
        const t = m.courseTitle ?? m.title;
        if (t) titles.set(id, String(t));
      } catch {
        /* no readable manifest: nothing to compare */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
  return titles;
}

// ---- small helpers ----
const human = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1073741824
        ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const csv = (v) =>
  /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.push({ rel: path.relative(base, p), size: fs.statSync(p).size });
  }
  return acc;
}

// Remembers which zip (by contents) was given which ID, so running the same command again
// after a dry run gives every course the same ID instead of the next one.
const sourcesDir = path.join(outDir, ".sources");
function loadSources() {
  const map = new Map();
  if (!fs.existsSync(sourcesDir)) return map;
  for (const f of fs.readdirSync(sourcesDir)) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      map.set(
        JSON.parse(fs.readFileSync(path.join(sourcesDir, f), "utf8")).sha256,
        Number(m[1]),
      );
    } catch {
      /* ignore */
    }
  }
  return map;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

// Reads the zip's central directory (yauzl) and streams each entry to disk, one at a time.
function extractAll(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    let count = 0;
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on("error", reject);
      zip.on("end", () => resolve(count));
      zip.on("entry", (entry) => {
        const rel = entry.fileName.replace(/\\/g, "/");
        if (rel.endsWith("/")) return zip.readEntry();
        const parts = rel.split("/");
        if (rel.startsWith("/") || parts.includes("..") || parts.includes("")) {
          return reject(new Error(`Unsafe path in zip: ${rel}`));
        }
        const target = path.join(destDir, ...parts);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, async (e, stream) => {
          if (e) return reject(e);
          try {
            await pipeline(stream, fs.createWriteStream(target));
            count++;
            zip.readEntry();
          } catch (x) {
            reject(x);
          }
        });
      });
      zip.readEntry();
    });
  });
}

function parseManifest(xml) {
  const p = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
  });
  const m = p.parse(xml).manifest;
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const schemaversion = String(m.metadata?.schemaversion ?? "");
  const scormVersion = /2004|CAM 1\.3/i.test(schemaversion) ? "2004" : "1.2";
  const orgs = m.organizations;
  const orgList = arr(orgs?.organization);
  const org =
    orgList.find((o) => o["@_identifier"] === orgs?.["@_default"]) ||
    orgList[0];
  const findItem = (items) => {
    for (const it of arr(items)) {
      if (it["@_identifierref"]) return it;
      const deep = findItem(it.item);
      if (deep) return deep;
    }
    return null;
  };
  const item = org && findItem(org.item);
  const res = arr(m.resources?.resource).find(
    (r) => r["@_identifier"] === item?.["@_identifierref"],
  );
  if (!res?.["@_href"])
    throw new Error("Could not find launchable resource in imsmanifest.xml");
  const title =
    typeof org?.title === "object" ? org.title["#text"] : org?.title;
  return {
    launchPath: res["@_href"],
    scormVersion,
    title: String(title ?? ""),
  };
}

// ---- 1. decide the ID of every course ----
fs.mkdirSync(outDir, { recursive: true });
const jobs = zips.map((zip) => ({
  zip,
  name: path.basename(zip),
  id: null,
  sha: null,
  error: null,
  warnings: [],
  status: "planned",
}));
let bucketIds = [];

function bucketFatal(e) {
  console.error(`Error: could not read ${BUCKET}/ : ${e.message}`);
  console.error(
    "Check the bucket name and that you are signed in (gcloud auth login) with access to it.",
  );
  process.exit(1);
}

if (mode === "replace") {
  const job = jobs[0];
  job.id = Number(flags.id);
  try {
    listBucketIds(); // fails early when the bucket name is wrong or not readable
    job.sha = await sha256(job.zip);
    if (!folderExists(job.id))
      job.error = `course ${job.id} is not in the bucket. Use "upload" to add a new course.`;
  } catch (e) {
    bucketFatal(e);
  }
} else {
  try {
    bucketIds = listBucketIds();
  } catch (e) {
    bucketFatal(e);
  }
  const sources = loadSources();
  const localIds = fs
    .readdirSync(outDir)
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
  let next = Math.max(0, ...bucketIds, ...localIds, ...sources.values()) + 1;
  const seenSha = new Map();
  for (const job of jobs) {
    try {
      job.sha = await sha256(job.zip);
      if (seenSha.has(job.sha)) {
        job.error = `same contents as ${seenSha.get(job.sha)}. Remove the duplicate zip.`;
        continue;
      }
      seenSha.set(job.sha, job.name);
      job.id = sources.get(job.sha) ?? next++;
      if (manifestExists(job.id)) {
        job.error = `ID ${job.id} is already a finished course in the bucket. To upload this zip over it, use: replace <zip> --id ${job.id}`;
      }
    } catch (e) {
      job.error = e.message;
    }
  }
}

// ---- 2. unzip locally (always; this is the dry run) ----
const startedAt = stamp();
for (const job of jobs.filter((j) => !j.error)) {
  const dir = path.join(outDir, String(job.id));
  const tmp = path.join(outDir, `.tmp-${job.id}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    let info;
    try {
      await extractAll(job.zip, tmp);
      const ims = path.join(tmp, "imsmanifest.xml");
      if (!fs.existsSync(ims))
        throw new Error("imsmanifest.xml not found at zip root");
      info = parseManifest(fs.readFileSync(ims, "utf8"));
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true }); // never leave a half-extracted folder
      throw e;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);

    job.title = info.title.trim();
    if (!job.title) {
      job.title = job.name.replace(/\.zip$/i, "");
      job.warnings.push(
        `the package has no title, using the file name "${job.title}"`,
      );
    }
    job.launchPath = info.launchPath;
    job.scormVersion = info.scormVersion;
    job.dir = dir;
    job.manifestText =
      JSON.stringify({ version: startedAt, courseTitle: job.title }, null, 2) +
      "\n";
    // Manifest last: its presence means the folder is complete.
    fs.writeFileSync(path.join(dir, "manifest.json"), job.manifestText);
    const files = walk(dir);
    job.files = files.length;
    job.bytes = files.reduce((n, f) => n + f.size, 0);

    fs.mkdirSync(sourcesDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourcesDir, `${job.id}.json`),
      JSON.stringify({ sha256: job.sha, zip: job.name, at: startedAt }),
    );
  } catch (e) {
    job.error = e.message;
  }
}

// ---- 3. sanity checks against what is already in the bucket ----
if (mode === "upload") {
  const ready = jobs.filter((j) => !j.error);
  if (ready.length && bucketIds.length) {
    console.log(
      `Checking ${bucketIds.length} existing course(s) for duplicate titles...`,
    );
    const titles = await remoteTitles(bucketIds);
    for (const job of ready) {
      for (const [id, t] of titles) {
        if (norm(t) === norm(job.title))
          job.warnings.push(
            `course ${id} already has this title ("${t}"). Is this meant to be "replace --id ${id}"?`,
          );
      }
    }
  }
} else {
  const job = jobs[0];
  if (!job.error) {
    const old = readRemoteManifest(job.id);
    const oldTitle = old?.courseTitle ?? old?.title;
    if (oldTitle && norm(oldTitle) !== norm(job.title)) {
      job.warnings.push(
        `the bucket has "${oldTitle}" as course ${job.id}, but this zip is "${job.title}". Make sure it is the right zip.`,
      );
    }
    job.replacing = oldTitle
      ? `${oldTitle}${old?.version ? ` (version ${old.version})` : ""}`
      : "(no readable manifest)";
  }
}

// ---- 4. print the plan ----
console.log(`\n${flags.apply ? "Plan" : "Dry run"}: ${mode}, ${BUCKET}/\n`);
for (const j of jobs) {
  if (j.error) {
    console.log(
      `  ${j.id ?? "?"}  ${j.name}\n      cannot proceed: ${j.error}`,
    );
    continue;
  }
  console.log(
    `  ${String(j.id).padEnd(4)}"${j.title}"  SCORM ${j.scormVersion}, launch ${j.launchPath}`,
  );
  console.log(`      ${j.files} files, ${human(j.bytes)}   from ${j.name}`);
  console.log(`      unzipped to ${j.dir}`);
  if (mode === "replace") console.log(`      replaces: ${j.replacing}`);
  for (const w of j.warnings) console.log(`      WARNING: ${w}`);
}

const okJobs = () => jobs.filter((j) => !j.error);

function writeSummary() {
  const file = path.join(outDir, `summary-${startedAt.replace(/:/g, "-")}.csv`);
  const rows = [
    ["id", "title", "zip", "mode", "status"],
    ...jobs.map((j) => [
      j.id ?? "",
      j.title ?? "",
      j.name,
      mode,
      j.error ? `failed: ${j.error}` : j.status,
    ]),
  ];
  fs.writeFileSync(
    file,
    rows.map((r) => r.map(csv).join(",")).join("\n") + "\n",
  );
  return file;
}

if (!flags.apply) {
  const summary = writeSummary();
  console.log(`\nDry run: unzipped into ${outDir}. Nothing was uploaded.`);
  console.log(`Summary: ${summary}`);
  if (okJobs().length)
    console.log("To upload, run the same command again with --apply.");
  process.exit(jobs.some((j) => j.error) ? 1 : 0);
}

// ---- 5. upload (--apply) ----
function verify(job, dest) {
  const dry = spawnSync(
    "gcloud",
    [
      "storage",
      "rsync",
      "--recursive",
      "--dry-run",
      "--checksums-only",
      "--delete-unmatched-destination-objects",
      job.dir,
      dest,
      `--exclude=${EXCLUDE}`,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const out = `${dry.stdout || ""}${dry.stderr || ""}`;
  if (dry.status !== 0 || /^\s*Would /m.test(out) || /ERROR/.test(out)) {
    throw new Error(
      `check failed: the bucket does not match your local folder.\n${out
        .split("\n")
        .filter((l) => /Would |ERROR/.test(l))
        .slice(0, 10)
        .join("\n")}`,
    );
  }
  const remote = gc(["cat", `${dest}/manifest.json`]).stdout;
  if (remote !== job.manifestText)
    throw new Error(
      "check failed: manifest.json in the bucket differs from your local one",
    );
}

console.log("");
for (const job of okJobs()) {
  const dest = `${BUCKET}/${job.id}`;
  try {
    console.log(`Course ${job.id} "${job.title}"`);
    if (mode === "replace") {
      if (!folderExists(job.id))
        throw new Error(`course ${job.id} is no longer in the bucket`);
      console.log(
        `  deleting the old folder ${dest}/ (the course is unavailable until the upload finishes)`,
      );
      gcRun(["rm", "--recursive", `${dest}/`]);
    } else if (manifestExists(job.id)) {
      throw new Error(
        `ID ${job.id} became a finished course in the bucket since the plan (another upload?). Nothing uploaded.`,
      );
    }
    console.log("  uploading files");
    gcRun(["rsync", "--recursive", job.dir, dest, `--exclude=${EXCLUDE}`]);
    console.log("  uploading manifest.json (last)");
    gcRun(["cp", path.join(job.dir, "manifest.json"), `${dest}/manifest.json`]);
    console.log("  checking the upload");
    verify(job, dest);
    job.status = "uploaded and checked";
    console.log("  done");
  } catch (e) {
    job.error = e.message;
    const half =
      mode === "replace"
        ? ` Course ${job.id} may be incomplete in the bucket. Run the same command again with --apply to finish it.`
        : "";
    console.error(`  FAILED: ${e.message}${half}`);
  }
}

// ---- 6. summary ----
const summary = writeSummary();
console.log("\nSummary");
for (const j of jobs)
  console.log(
    `  ${String(j.id ?? "?").padEnd(4)}${(j.title ?? j.name).padEnd(40)}${j.error ? `FAILED: ${j.error.split("\n")[0]}` : j.status}`,
  );
console.log(`\nFile: ${summary}`);
const failed = jobs.filter((j) => j.error).length;
if (!failed && mode === "upload")
  console.log(
    "Next: enter each ID in its Builder content (course ID field) and publish.",
  );
console.log(failed ? `\n${failed} course(s) failed.` : "\nAll done.");
process.exit(failed ? 1 : 0);
