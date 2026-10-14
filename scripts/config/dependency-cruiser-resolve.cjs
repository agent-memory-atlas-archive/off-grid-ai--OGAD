// Vite's URL suffix is not part of the package export. Resolve the real worker
// file so a missing export still fails the dependency gate.
module.exports = {
  resolve: {
    alias: {
      '@offgrid/operator-ui/pdf.worker.min.mjs$': require.resolve(
        '@offgrid/operator-ui/pdf.worker.min.mjs'
      )
    }
  }
}
