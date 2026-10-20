import pruneOnnxRuntime from './prune-onnx-runtime.mjs'
import { thinMacUniversalBinaries } from './thin-mac-binaries.mjs'

// electron-builder runs afterPack before code signing: everything here changes files that
// the signing pass then signs in their final form.
export default async function afterPack(context) {
  await pruneOnnxRuntime(context)
  thinMacUniversalBinaries(context)
}
