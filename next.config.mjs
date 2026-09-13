/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server under .next/standalone. That directory is what
  // the single-file Windows executable carries; `next dev` and `next start` are
  // unaffected by it.
  output: 'standalone',

  // `pg`, `mammoth` and `docx` are server-only and must not be bundled for the browser.
  serverExternalPackages: ['pg', 'mammoth', 'docx'],
};

export default nextConfig;
