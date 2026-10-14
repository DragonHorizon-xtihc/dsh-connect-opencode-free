// Static use-before-declaration scan, scoped to the settings page component.
//
// The blank-page bug was a `const` read before its declaration inside the page
// component, which only throws at render time. `node --check` cannot see it, and
// the unit tests never import the page — so this walks the component function
// body and reports any local read on a line before the line that declares it.
//
// Scope is deliberately narrow: the whole file is not one scope, so scanning it
// flat reports function parameters, object-literal keys and imports as
// violations. Everything here is scoped to the component's own body, and
// function declarations plus destructured parameters are treated as hoisted.
//
// The indent is derived from the body's first line rather than hardcoded, so the
// scan survives a reformat. A scan that silently matches nothing is worse than
// no scan at all, so the derived indent is asserted to have actually produced
// declarations before the result is trusted.
//
// Run: node scripts/tdz-scan.mjs [path-to-client.js]

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TARGET = process.argv[2] ?? join(PACKAGE_ROOT, 'src/client.js')

const lines = readFileSync(TARGET, 'utf8').split('\n')

/** Locate the component function: the one whose body renders the page. */
function componentRange() {
  const start = lines.findIndex((l) => /^function OpenCodeFreeSettings\(/.test(l))
  if (start === -1) throw new Error('component function not found; the scan needs a stable anchor')
  // The function ends at the first line that is a top-level `}` after the start.
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    if (/^}/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

const { start, end } = componentRange()
const body = lines.slice(start, end + 1)

// The body's own indent, taken from the first statement inside the function.
// Everything at this indent is a component-scope local; deeper indents belong to
// nested blocks and callbacks, whose reads are legal wherever they appear.
const INDENT = (body[1] ?? '').match(/^\s*/)[0]
if (INDENT.length === 0) throw new Error('could not derive the component body indent')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const declRe = new RegExp(`^${esc(INDENT)}(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=(?!=)`)
const destructRe = new RegExp(`^${esc(INDENT)}(?:const|let)\\s*(?:\\[([^\\]]*)\\]|\\{([^}]*)\\})\\s*=`)
const fnDeclRe = new RegExp(`^${esc(INDENT)}(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)`)

/** Names each body line declares, so a read of its own name on that line is fine. */
const declaredOn = new Map()
/** Body line index (0-based) -> file line number (0-based) where it is declared. */
const declLine = new Map()
body.forEach((line, i) => {
  const m = line.match(declRe)
  if (!m) return
  const names = new Set([m[1]])
  const destruct = line.match(destructRe)
  if (destruct) {
    for (const part of (destruct[1] ?? destruct[2]).split(',')) {
      const name = part.split(':').pop().trim().replace(/^\.\.\./, '').split(/\s*=/)[0].trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  if (!declLine.has(m[1])) declLine.set(m[1], start + i)
  declaredOn.set(i, names)
})

// Parameters and destructured names are hoisted into the body's scope, so a read
// on line 1 of the body is legal. This also covers the parameters of every
// nested callback, which is what `(id) => ...` and `(entry) => ...` declare —
// without them a callback's own parameter reads as a violation of the outer
// scope's local of the same name.
const hoisted = new Set()
for (const m of body[0].matchAll(/([A-Za-z_$][\w$]*)/g)) hoisted.add(m[1])
for (let i = 1; i < body.length; i++) {
  const line = body[i]
  const fn = line.match(fnDeclRe)
  if (fn) { hoisted.add(fn[1]); continue }
  const destruct = line.match(destructRe)
  if (destruct) {
    for (const part of (destruct[1] ?? destruct[2]).split(',')) {
      const name = part.split(':').pop().trim().replace(/^\.\.\./, '').split(/\s*=/)[0].trim()
      if (name) hoisted.add(name)
    }
  }
  // Callback parameters: `(name) =>`, `function (name)`, `(name) => {`.
  for (const m of line.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim().split(/\s*=/)[0].trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) hoisted.add(name)
    }
  }
  for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) hoisted.add(m[1])
}

const problems = []
for (let i = 1; i < body.length; i++) {
  const line = body[i]
  const ownNames = declaredOn.get(i) ?? new Set()
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue // comment
  // Object-literal keys (`key: value`) are not variable reads, wherever they sit
  // — including inside a call argument like `useState({ id: '' })`.
  if (/^\s*[\w$]+\s*:/.test(line)) continue
  for (const [name, decl] of declLine) {
    if (decl < start + i) continue // declared earlier: fine
    if (hoisted.has(name)) continue
    if (ownNames.has(name)) continue // this line declares it; not a read
    const useRe = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\b`, 'g')
    for (const m of line.matchAll(useRe)) {
      const before = line.slice(0, m.index)
      const after = line.slice(m.index + m[0].length)
      if (/['"`]/.test(before)) continue // inside a string literal
      if (/^\s*:/.test(after)) continue // object-literal key position
      problems.push(`${name}: read on line ${start + i + 1}, declared on line ${decl + 1}`)
    }
  }
}

const unique = [...new Set(problems)]
if (declLine.size < 10) {
  // A scan that matches nothing reports a clean bill of health it has not earned.
  console.error(`only ${declLine.size} component locals matched; the indent derivation is wrong, refusing to pass`)
  process.exit(1)
}
if (unique.length === 0) {
  console.log(`no use-before-declaration in the page component (${declLine.size} locals checked)`)
} else {
  console.error(`USE BEFORE DECLARATION (${unique.length}) — these throw at render, i.e. a blank page:`)
  for (const p of unique) console.error(`  ${p}`)
  process.exit(1)
}
