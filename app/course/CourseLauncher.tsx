"use client";

import { useState } from "react";

interface CourseManifest {
  version: string;
  launchPath: string;
  scormVersion: "1.2" | "2004";
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "running"; src: string; scormVersion: string };

export default function CourseLauncher() {
  const [courseId, setCourseId] = useState("demo-course");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [events, setEvents] = useState<string[]>([]);

  async function start() {
    setState({ kind: "loading" });
    setEvents([]);

    // 1. Read the pointer file. Anything but a valid manifest means "not available".
    let manifest: CourseManifest;
    try {
      const res = await fetch(`/scorm/${encodeURIComponent(courseId)}/manifest.json`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      manifest = await res.json();
      if (!manifest.version || !manifest.launchPath || !manifest.scormVersion) throw new Error("bad manifest");
    } catch {
      setState({ kind: "unavailable" });
      return;
    }

    // 2. Create the SCORM API object on this page and expose it under the name the course looks for.
    const { Scorm12API, Scorm2004API } = await import("scorm-again");
    const log = (name: string, value: unknown) =>
      setEvents((prev) => [...prev, `${name} = ${JSON.stringify(value)}`].slice(-30));

    if (manifest.scormVersion === "2004") {
      const api = new Scorm2004API({ logLevel: 4 });
      api.on("SetValue.cmi.*", (name: string, value: unknown) => log(name, value));
      api.on("Commit", () => log("Commit", api.renderCommitCMI(true)));
      (window as any).API_1484_11 = api;
    } else {
      const api = new Scorm12API({ logLevel: 4 });
      api.on("LMSSetValue.cmi.*", (name: string, value: unknown) => log(name, value));
      api.on("LMSCommit", () => log("LMSCommit", api.renderCommitCMI(true)));
      (window as any).API = api;
    }

    // 3. Point the iframe at the versioned launch file, served from this app's own origin.
    const base = `/scorm/${encodeURIComponent(courseId)}/${encodeURIComponent(manifest.version)}`;
    const launch = manifest.launchPath.split("/").map(encodeURIComponent).join("/");
    setState({ kind: "running", src: `${base}/${launch}`, scormVersion: manifest.scormVersion });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          aria-label="Course ID"
          style={{ flex: 1, padding: 8, fontSize: 16 }}
        />
        <button onClick={start} disabled={state.kind === "loading" || !courseId.trim()} style={{ padding: "8px 20px", fontSize: 16 }}>
          Start course
        </button>
      </div>

      {state.kind === "loading" && <p>Loading…</p>}
      {state.kind === "unavailable" && <p role="alert">This course is not available.</p>}

      {state.kind === "running" && (
        <>
          <p style={{ color: "#555" }}>
            SCORM {state.scormVersion} · <code>{state.src}</code>
          </p>
          <iframe
            key={state.src}
            src={state.src}
            title="Course"
            style={{ width: "100%", height: 520, border: "1px solid #ccc", background: "#fff" }}
          />
          <h3>Tracking calls received by the API object</h3>
          <pre style={{ background: "#111", color: "#9f9", padding: 12, minHeight: 80, overflow: "auto" }}>
            {events.length ? events.join("\n") : "(none yet)"}
          </pre>
        </>
      )}
    </div>
  );
}
