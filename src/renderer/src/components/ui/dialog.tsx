// Drop-in: this primitive now lives in @offgrid/operator-ui (src/hosts/ogad/ui/dialog.tsx)
// with the same exports and props. Edit it there, not here.
//
// OGAD-only wiring: native-surface occlusion is an app concern the library cannot
// import, so it is registered here, once, when this module loads. Every mounted
// DialogContent (including CommandDialog's) then acquires it when its node attaches
// and releases it when it detaches or unmounts - the same timing as before - so
// Electron's native child views stay below open dialogs.
import { registerDialogOcclusion } from '@offgrid/operator-ui/ogad/ui/dialog'
import { acquireNativeSurfaceOcclusion } from '@/lib/native-surface-occlusion'

registerDialogOcclusion(acquireNativeSurfaceOcclusion)

// eslint-disable-next-line react-refresh/only-export-components -- re-export shim; the components are defined in @offgrid/operator-ui
export * from '@offgrid/operator-ui/ogad/ui/dialog'
