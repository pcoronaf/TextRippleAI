/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg`, `mammoth` and `docx` are server-only and must not be bundled for the browser.
  serverExternalPackages: ['pg', 'mammoth', 'docx'],
};

export default nextConfig;
