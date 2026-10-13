// Drop-in: this primitive now lives in @offgrid/operator-ui (src/hosts/ogad/ui/command.tsx)
// with the same exports and props. Edit it there, not here.
//
// CommandDialog renders the library's OGAD dialog; importing ./dialog guarantees the
// native-surface occlusion is registered even when a screen imports only this module.
import './dialog'

// eslint-disable-next-line react-refresh/only-export-components -- re-export shim; the components are defined in @offgrid/operator-ui
export * from '@offgrid/operator-ui/ogad/ui/command'
