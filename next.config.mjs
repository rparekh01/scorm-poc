/** @type {import('next').NextConfig} */
const nextConfig = {
  // local-data is only for the local test adapter. Keep it out of the server bundle.
  outputFileTracingExcludes: { "/scorm/[...path]": ["./local-data/**/*"], "/*": ["./local-data/**/*"] },
};
export default nextConfig;
