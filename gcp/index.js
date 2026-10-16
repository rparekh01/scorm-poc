const functions = require("@google-cloud/functions-framework");
const { Storage } = require("@google-cloud/storage");
const { XMLParser } = require("fast-xml-parser");
const yauzl = require("yauzl");
const mime = require("mime-types");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");

const storage = new Storage();
const OUT_BUCKET = process.env.EXTRACTED_BUCKET;

functions.cloudEvent("unzipCourse", async (event) => {
  const { bucket, name } = event.data;
  if (!name.toLowerCase().endsWith(".zip") || name.includes("/")) {
    console.log(`Skipping ${name}`);
    return;
  }
  const courseId = name.slice(0, -4);
  const tmp = path.join(os.tmpdir(), `${courseId}-${Date.now()}.zip`);
  try {
    await storage.bucket(bucket).file(name).download({ destination: tmp });
    const version = (await sha256(tmp)).slice(0, 12);
    const out = storage.bucket(OUT_BUCKET);
    const manifestFile = out.file(`${courseId}/manifest.json`);

    let previous = null;
    try {
      previous = JSON.parse((await manifestFile.download())[0].toString());
    } catch {}
    if (previous && previous.version === version) {
      console.log(`${courseId} already at ${version}, nothing to do`);
      return;
    }

    const files = await extractAll(tmp, out, `${courseId}/${version}`);
    const imsRaw = files.get("imsmanifest.xml");
    if (!imsRaw) throw new Error("imsmanifest.xml not found at zip root");
    const info = parseManifest(imsRaw);

    // Manifest is written last: its presence means the extraction is complete.
    await manifestFile.save(
      JSON.stringify(
        {
          builderId: courseId,
          version,
          launchPath: info.launchPath,
          scormVersion: info.scormVersion,
          title: info.title,
          extractedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { contentType: "application/json", resumable: false }
    );

    if (previous && previous.version && previous.version !== version) {
      await out.deleteFiles({ prefix: `${courseId}/${previous.version}/` });
    }
    console.log(`${courseId}: extracted ${files.size ? "ok" : "?"} as ${version}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

// Streams each zip entry to the extracted bucket. Returns a Map of the small
// files we need to read afterwards (imsmanifest.xml).
function extractAll(zipPath, outBucket, prefix) {
  return new Promise((resolve, reject) => {
    const kept = new Map();
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on("error", reject);
      zip.on("end", () => resolve(kept));
      zip.readEntry();
      zip.on("entry", (entry) => {
        const rel = entry.fileName.replace(/\\/g, "/");
        if (rel.endsWith("/")) return zip.readEntry();
        const parts = rel.split("/");
        if (rel.startsWith("/") || parts.includes("..")) {
          return reject(new Error(`Unsafe path in zip: ${rel}`));
        }
        zip.openReadStream(entry, async (e, stream) => {
          if (e) return reject(e);
          try {
            const dest = outBucket.file(`${prefix}/${rel}`).createWriteStream({
              resumable: false,
              contentType: mime.lookup(rel) || "application/octet-stream",
            });
            if (rel === "imsmanifest.xml") {
              const chunks = [];
              stream.on("data", (c) => chunks.push(c));
              await pipeline(stream, dest);
              kept.set(rel, Buffer.concat(chunks).toString("utf8"));
            } else {
              await pipeline(stream, dest);
            }
            zip.readEntry();
          } catch (x) {
            reject(x);
          }
        });
      });
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
  const resources = arr(m.resources?.resource);
  const res = resources.find((r) => r["@_identifier"] === item?.["@_identifierref"]);
  if (!res?.["@_href"]) throw new Error("Could not find launchable resource in imsmanifest.xml");

  const title = typeof org?.title === "object" ? org.title["#text"] : org?.title;
  return { launchPath: res["@_href"], scormVersion, title: String(title ?? "") };
}
