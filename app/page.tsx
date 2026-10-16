import CourseLauncher from "./course/CourseLauncher";

export default function Home() {
  return (
    <main style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>SCORM proof of concept</h1>
      <p>
        Enter a course ID (the folder name in the extracted bucket, or in <code>local-data</code> when testing
        locally) and press Start course.
      </p>
      <CourseLauncher />
    </main>
  );
}
