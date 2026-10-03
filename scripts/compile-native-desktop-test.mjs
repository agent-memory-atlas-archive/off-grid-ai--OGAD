// Compile modules separately so native V8 coverage retains function boundaries.
// Bundling many modules into one script can assign the bundle's startup count to
// uncalled source bodies after source-map conversion.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const output = path.resolve(process.argv[2])
const compiled = path.join(output, 'compiled')
const fixture = 'pro/main/__tests__/native-desktop.fixture.ts'
const sources = []
const pending = ['src', 'pro/main', 'pro/shared']
while (pending.length) {
  const directory = pending.pop()
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== '__tests__') pending.push(file)
    else if (entry.isFile() && /\.tsx?$/.test(file) && !/\.d\.ts$|\.test\./.test(file))
      sources.push(file)
  }
}
sources.push(fixture)
const aliases = [
  ['@offgrid/core/', 'src/'],
  ['@offgrid/pro/', 'pro/'],
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]
for (const file of sources) {
  const target = path.join(compiled, file.replace(/\.tsx?$/, '.js'))
  let source = fs.readFileSync(file, 'utf8')
  source = source.replace(
    /(['"])(@offgrid\/core\/|@offgrid\/pro\/|@renderer\/|@\/)([^'"]+)\1/g,
    (_match, _quote, prefix, suffix) => {
      const directory = aliases.find(([name]) => name === prefix)[1]
      let relative = path
        .relative(path.dirname(target), path.join(compiled, directory, suffix))
        .replaceAll('\\', '/')
      if (!relative.startsWith('.')) relative = './' + relative
      return JSON.stringify(relative)
    }
  )
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(target).href))
  source = source.replace(
    '../resources/linux-desktop/meeting-recorder.py?raw',
    '../resources/linux-desktop/meeting-recorder-source.js'
  )
  const result = ts.transpileModule(source, {
    fileName: path.resolve(file),
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      sourceMap: true,
      inlineSources: true
    }
  })
  const map = JSON.parse(result.sourceMapText)
  map.sources = [path.resolve(file)]
  map.sourceRoot = ''
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(
    target,
    result.outputText.replace(
      /\/\/# sourceMappingURL=.*$/m,
      '//# sourceMappingURL=data:application/json;base64,' +
        Buffer.from(JSON.stringify(map)).toString('base64')
    )
  )
}
const recorder = path.join(compiled, 'pro/resources/linux-desktop/meeting-recorder-source.js')
fs.mkdirSync(path.dirname(recorder), { recursive: true })
fs.writeFileSync(
  recorder,
  'module.exports = {__esModule: true, default: ' +
    JSON.stringify(fs.readFileSync('pro/resources/linux-desktop/meeting-recorder.py', 'utf8')) +
    '};'
)
fs.writeFileSync(
  path.join(output, 'main.cjs'),
  'global.__OFFGRID_PRO__ = true; require("./compiled/pro/main/__tests__/native-desktop.fixture.js");'
)
