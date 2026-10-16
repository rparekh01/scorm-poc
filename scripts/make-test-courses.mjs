// Builds two multi-step SCORM 1.2 test courses (needs ffmpeg and zip on PATH):
//   big-course    6 video steps (8.5-10 min each) + quiz, ~500 MB unzipped
//   small-course  6 text steps with an image each + quiz, ~20 MB unzipped
// Output: test-course/{id}.zip (upload to the zips bucket) and local-data/{id}/... (pre-extracted,
// for STORAGE_ADAPTER=local).   Usage: node scripts/make-test-courses.mjs [big|small|both]
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const which = process.argv[2] ?? "both";
const tpl = path.resolve("scripts/course-template");
const FONT = ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"].find(existsSync);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"], ...opts });
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

function dirSize(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    const p = path.join(dir, e.name);
    return sum + (e.isDirectory() ? dirSize(p) : statSync(p).size);
  }, 0);
}
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

function makeVideo(out, seconds, n) {
  const sources = [
    "testsrc2=size=1280x720:rate=24", "testsrc2=size=1280x720:rate=24,hue=h=60", "rgbtestsrc=size=1280x720:rate=24",
    "testsrc2=size=1280x720:rate=24,negate", "testsrc2=size=1280x720:rate=24,hue=h=180", "smptehdbars=size=1280x720:rate=24",
  ];
  let vf = `${sources[n % sources.length]},noise=alls=20:allf=t`;
  if (FONT) vf += `,drawtext=fontfile=${FONT}:text='Video ${n + 1} of 6':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.6:x=40:y=40`;
  run("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", vf, "-f", "lavfi", "-i", `sine=frequency=${200 + n * 60}:sample_rate=44100`,
    "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "1100k", "-maxrate", "1300k", "-bufsize", "2600k",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-shortest", "-movflags", "+faststart", out]);
}
function makeImage(out, n) {
  const hue = n * 50;
  run("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=2880x1620:rate=1,hue=h=${hue},noise=alls=40:allf=t`,
    "-frames:v", "1", "-q:v", "2", out]);
}

const quiz = [0, 1, 2, 0, 1].map((pos, i) => ({
  q: `Test question ${i + 1}: select the option labeled "Correct".`,
  options: ["Wrong A", "Wrong B", "Wrong C"].map((w, k) => (k === pos ? "Correct" : w)),
  answer: pos,
}));

const TEXT = [
  ["Why this matters", ["Clear communication reduces errors and saves time. In this step we set out the goals of the course and what you will be able to do at the end of it.", "Each step is short. Read it, then continue. Your place is saved, so you can leave and come back."]],
  ["Know your audience", ["Before writing or speaking, decide who needs the message and what they already know. A message that suits a colleague may confuse a patient or a new starter.", "Ask one question first: what does this person need to do after reading this?"]],
  ["Be specific", ["Replace vague words with facts. Say what happened, when, and what you need. Use names, dates and numbers where you have them.", "Short sentences are easier to follow than long ones, especially under pressure."]],
  ["Choose the right channel", ["Urgent matters need a call or a face-to-face conversation. Routine updates can go by email or message. Anything that must be recorded should be written down.", "If you are unsure, pick the channel that gives the other person the least room to misunderstand."]],
  ["Listen and confirm", ["Communication goes both ways. Repeat back the key points and ask the other person to confirm them.", "A short confirmation costs seconds. A misunderstanding can cost hours."]],
  ["Put it into practice", ["Pick one conversation this week and apply the steps in this course: audience, specifics, channel and confirmation.", "When you are ready, continue to the quiz to finish the course."]],
];

const COURSES = {
  "big-course": {
    title: "Big course (6 videos)",
    build(src) {
      mkdirSync(path.join(src, "content/media"), { recursive: true });
      const minutes = [8.5, 9, 9.5, 10, 10, 10];
      const steps = minutes.map((m, i) => {
        process.stdout.write(`  encoding video ${i + 1}/6 (${m} min)...\n`);
        makeVideo(path.join(src, `content/media/video${i + 1}.mp4`), Math.round(m * 60), i);
        return { type: "video", title: `Video ${i + 1}`, src: `media/video${i + 1}.mp4`, minutes: m };
      });
      return steps;
    },
  },
  "small-course": {
    title: "Small course (6 text steps)",
    build(src) {
      mkdirSync(path.join(src, "content/media"), { recursive: true });
      return TEXT.map(([title, body], i) => {
        makeImage(path.join(src, `content/media/step${i + 1}.jpg`), i);
        return { type: "text", title, image: `media/step${i + 1}.jpg`, body };
      });
    },
  },
};

function buildCourse(id) {
  const def = COURSES[id];
  const root = path.resolve("test-course", id);
  const src = path.join(root, "src");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(src, "content/scripts"), { recursive: true });
  console.log(`Building ${id}`);

  const steps = def.build(src);
  cpSync(path.join(tpl, "index.html"), path.join(src, "content/index.html"));
  cpSync(path.join(tpl, "player.js"), path.join(src, "content/scripts/player.js"));
  writeFileSync(path.join(src, "content/scripts/course.js"),
    "window.COURSE = " + JSON.stringify({ title: def.title, passMark: 80, steps, quiz }, null, 2) + ";\n");

  const files = listFiles(src);
  writeFileSync(path.join(src, "imsmanifest.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="1" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org1">
    <organization identifier="org1">
      <title>${def.title}</title>
      <item identifier="item1" identifierref="res1"><title>${def.title}</title><adlcp:masteryscore>80</adlcp:masteryscore></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res1" type="webcontent" adlcp:scormtype="sco" href="content/index.html">
${files.map((f) => `      <file href="${f}"/>`).join("\n")}
    </resource>
  </resources>
</manifest>
`);

  const zip = path.resolve("test-course", `${id}.zip`);
  rmSync(zip, { force: true });
  run("zip", ["-qr", zip, "."], { cwd: src });
  const hash = execFileSync("sha256sum", [zip]).toString().slice(0, 12);

  const out = path.resolve("local-data", id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, path.join(out, hash), { recursive: true });
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify({
    builderId: id, version: hash, launchPath: "content/index.html", scormVersion: "1.2",
    title: def.title, extractedAt: new Date().toISOString(),
  }, null, 2));
  rmSync(root, { recursive: true, force: true });

  console.log(`  ${id}: unzipped ${mb(dirSize(path.join(out, hash)))}, zip ${mb(statSync(zip).size)}, ${files.length} files, version ${hash}`);
}

if (which === "big" || which === "both") buildCourse("big-course");
if (which === "small" || which === "both") buildCourse("small-course");
