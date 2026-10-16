#!/usr/bin/env node
// Local version of the unzip Cloud Function.
//
//   node scripts/unzip-local.mjs <zip-or-folder> [--out ./extracted] [--upload gs://bucket]
//
// For each zip (file name minus .zip = course ID) it writes
//   <out>/<id>/<hash>/...        every file from the zip
//   <out>/<id>/manifest.json     written last
// and removes the previous hash folder. With --upload it then pushes the course to the
// extracted bucket with the gcloud CLI, in the same order (files, manifest last, old version removed).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { XMLParser } from "fast-xml-parser";

// ---- args ----
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const [, v] = args.splice(i, 2);
  return v ?? null;
};
const outDir = path.resolve(opt("--out") ?? "extracted");
const bucket = opt("--upload");
const input = args[0];
if (!input || (bucket && !/^gs:\/\/[^/]+\/?$/.test(bucket))) {
  console.error("Usage: node scripts/unzip-local.mjs <zip-or-folder> [--out ./extracted] [--upload gs://bucket]");
  process.exit(1);
}

const zips = fs.statSync(input).isDirectory()
  ? fs.readdirSync(input).filter((f) => f.toLowerCase().endsWith(".zip")).map((f) => path.join(input, f))
  : [input];
if (zips.length === 0) {
  console.error("No .zip files found");
  process.exit(1);
}

let failed = 0;
for (const zip of zips) {
  try {
    await processZip(zip);
  } catch (e) {
    failed++;
    console.error(`FAILED ${path.basename(zip)}: ${e.message}`);
  }
}
console.log(failed ? `Done with ${failed} failure(s).` : "Done.");
process.exit(failed ? 1 : 0);

// ---- per course ----
async function processZip(zipPath) {
  const id = path.basename(zipPath).replace(/\.zip$/i, "");
  const version = (await sha256(zipPath)).slice(0, 12);
  const courseDir = path.join(outDir, id);
  const manifestPath = path.join(courseDir, "manifest.json");

  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}

  if (previous?.version === version && fs.existsSync(path.join(courseDir, version))) {
    console.log(`${id}: already extracted as ${version}`);
  } else {
    // Extract into a temp folder, then rename, so a crash never leaves a half-filled version folder.
    const tmp = path.join(courseDir, `.tmp-${version}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    let count, info;
    try {
      count = await extractAll(zipPath, tmp);
      const ims = path.join(tmp, "imsmanifest.xml");
      if (!fs.existsSync(ims)) throw new Error("imsmanifest.xml not found at zip root");
      info = parseManifest(fs.readFileSync(ims, "utf8"));
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true }); // never leave a half-extracted folder
      if (fs.existsSync(courseDir) && fs.readdirSync(courseDir).length === 0) fs.rmdirSync(courseDir);
      throw e;
    }

    const finalDir = path.join(courseDir, version);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmp, finalDir);

    // Manifest last: its presence means the extraction is complete.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        { builderId: id, version, launchPath: info.launchPath, scormVersion: info.scormVersion,
          title: info.title, extractedAt: new Date().toISOString() },
        null, 2
      )
    );
    if (previous?.version && previous.version !== version) {
      fs.rmSync(path.join(courseDir, previous.version), { recursive: true, force: true });
    }
    console.log(`${id}: extracted ${count} files as ${version} (${info.scormVersion}, launch ${info.launchPath})`);
  }

  if (bucket) upload(id, version, courseDir);
}

// ---- upload with the gcloud CLI ----
function gcloud(...a) {
  return execFileSync("gcloud", a, { stdio: ["ignore", "pipe", "inherit"] }).toString();
}
function upload(id, version, courseDir) {
  const dest = `${bucket.replace(/\/$/, "")}/${id}`;
  let remotePrev = null;
  try { remotePrev = JSON.parse(gcloud("storage", "cat", `${dest}/manifest.json`)).version; } catch {}

  if (remotePrev === version) {
    console.log(`${id}: bucket already at ${version}, nothing to upload`);
    return;
  }
  console.log(`${id}: uploading ${version} ...`);
  gcloud("storage", "rsync", "--recursive", path.join(courseDir, version), `${dest}/${version}`);
  gcloud("storage", "cp", path.join(courseDir, "manifest.json"), `${dest}/manifest.json`); // last
  if (remotePrev) gcloud("storage", "rm", "--recursive", `${dest}/${remotePrev}/`);
  console.log(`${id}: uploaded${remotePrev ? `, removed old version ${remotePrev}` : ""}`);
}

// ---- helpers (parseManifest is the same logic as gcp/index.js) ----
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
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
          } catch (x) { reject(x); }
        });
      });
      zip.readEntry();
    });
  });
}

function parseManifest(xml) {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const m = p.parse(xml).manifest;
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const schemaversion = String(m.metadata?.schemaversion ?? "");
  const scormVersion = /2004|CAM 1\.3/i.test(schemaversion) ? "2004" : "1.2";
  const orgs = m.organizations;
  const orgList = arr(orgs?.organization);
  const org = orgList.find((o) => o["@_identifier"] === orgs?.["@_default"]) || orgList[0];
  const findItem = (items) => {
    for (const it of arr(items)) {
      if (it["@_identifierref"]) return it;
      const deep = findItem(it.item);
      if (deep) return deep;
    }
    return null;
  };
  const item = org && findItem(org.item);
  const res = arr(m.resources?.resource).find((r) => r["@_identifier"] === item?.["@_identifierref"]);
  if (!res?.["@_href"]) throw new Error("Could not find launchable resource in imsmanifest.xml");
  const title = typeof org?.title === "object" ? org.title["#text"] : org?.title;
  return { launchPath: res["@_href"], scormVersion, title: String(title ?? "") };
}
