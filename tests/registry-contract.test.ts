/* The registry is the source for every name shared with the box, and this is
 * what keeps that true on this side.
 *
 * The generator lives in the box; there is none here, so the check is this
 * file. Without it the tables in src/lib/protocol are three hand-written
 * copies of the registry that nothing compares against it — and the registry's
 * own header says it exists because three separate authorisation namespaces
 * once grew up in this codebase.
 *
 * This is half the discipline. It checks this repository's copy of the
 * registry against this repository's code. That the box's copy is the same
 * file is the other half, and it cannot be checked from inside one clone —
 * scripts/check-contract-drift.mjs does it in CI with both checked out.
 *
 * Deliberately not a YAML parser. Adding one to read six blocks out of one
 * file would be a dependency in the shipping tree for a test, and the blocks
 * are flat lists whose shape is itself part of what is being pinned.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { isRetryable } from '$lib/protocol/messages'
import { SCOPES, ROLE_SCOPES, ROLE_LABELS } from '$lib/protocol/contract'
import { FID } from '$lib/format/explanation'

/** From the project root, which is where vitest runs. */
const root = (p: string) => join(process.cwd(), p)

/**
 * Every non-test source file under src/, as a root-relative path with
 * forward slashes. Tests are left out: a literal in a test cannot hide a
 * feature from a user, and the box's names written plainly are often the
 * very thing a test asserts.
 */
function sourceFiles(): string[] {
  return readdirSync(root('src'), { recursive: true })
    .map((p) => `src/${String(p).split(sep).join('/')}`)
    .filter((p) => /\.(ts|svelte)$/.test(p) && !p.endsWith('.test.ts'))
}

const registry = readFileSync(root('contract/registry.yaml'), 'utf8')

/** Lines of one top-level block, comments and blanks dropped. */
function block(name: string): string[] {
  const lines = registry.split('\n')
  const start = lines.findIndex((l) => l === `${name}:`)
  expect(start, `contract/registry.yaml has no ${name}: block`).toBeGreaterThan(-1)

  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (!line.startsWith(' ')) break
    out.push(line)
  }
  return out
}

/**
 * One of the two error blocks.
 *
 * `errors` is what the box sends. `client_errors` is what this app raises for
 * itself and the box never sends — the session's deadlines and the box-api
 * layer's unreadable answers. Both are checked here, because a code exempt
 * from the check is a code that can drift.
 */
function registryErrors(name: 'errors' | 'client_errors' = 'errors'): {
  code: string
  retryable: boolean
}[] {
  return block(name).map((line) => {
    const m = /code:\s*(\S+?),\s*retryable:\s*(true|false)/.exec(line)
    expect(m, `unreadable error line: ${line}`).not.toBeNull()
    return { code: m![1]!, retryable: m![2] === 'true' }
  })
}

/** Every code the registry declares, in either block. */
function everyRegistryError(): { code: string; retryable: boolean }[] {
  return [...registryErrors('errors'), ...registryErrors('client_errors')]
}

/**
 * The app's own table, read out of the source it is written in.
 *
 * The table is what `isRetryable` answers from and what the simulator stamps
 * on every error frame it sends, so its keys are the set of codes this app
 * has heard of at all.
 */
function appErrorTable(): string[] {
  const source = readFileSync(root('src/lib/protocol/messages.ts'), 'utf8')
  const table = source.slice(source.indexOf('const RETRYABLE'), source.indexOf('/** Unknown codes'))
  return [...table.matchAll(/^\s*(E_[A-Z_]+):/gm)].map(([, code]) => code!)
}

function registryScopes(): string[] {
  return block('scopes').map((line) => {
    const m = /name:\s*(\S+?),/.exec(line)
    expect(m, `unreadable scope line: ${line}`).not.toBeNull()
    return m![1]!
  })
}

function registryCapabilities(): string[] {
  return block('capabilities').map((line) => line.trim().replace(/^-\s*/, ''))
}

function registryOps(): { name: string; scope: string }[] {
  return block('ops').map((line) => {
    const m = /name:\s*(\S+?),\s*scope:\s*(\S+?),/.exec(line)
    expect(m, `unreadable op line: ${line}`).not.toBeNull()
    return { name: m![1]!, scope: m![2]! }
  })
}

/**
 * The `OP_` constants in messages.ts, name and wire string together.
 *
 * Read out of the source like the app's error table above: the constants are
 * the set of operations this app can put in a `cmd` frame at all.
 */
function appOps(): Record<string, string> {
  const source = readFileSync(root('src/lib/protocol/messages.ts'), 'utf8')
  return Object.fromEntries(
    [...source.matchAll(/^export const (OP_[A-Z_]+) = '([^']+)'$/gm)].map(([, n, v]) => [n!, v!])
  )
}

/** roles is nested, so it is read as one indented sub-block per role. */
function registryRoles(): Record<string, { label: string; scopes: string[] }> {
  const out: Record<string, { label: string; scopes: string[] }> = {}
  let current: string | null = null

  for (const line of block('roles')) {
    const role = /^ {2}(\w+):\s*$/.exec(line)
    if (role) {
      current = role[1]!
      out[current] = { label: '', scopes: [] }
      continue
    }
    if (!current) continue

    const label = /^ {4}label:\s*(.+)$/.exec(line)
    if (label) out[current]!.label = label[1]!.trim()

    const scopes = /^ {4}scopes:\s*\[(.*)\]$/.exec(line)
    if (scopes) {
      out[current]!.scopes = scopes[1]!
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean)
    }
  }
  return out
}

describe('the error catalogue', () => {
  /**
   * Set equality, not containment in one direction.
   *
   * Containment was what this checked before, and it could not see a code the
   * box sends that the app has never heard of: `isRetryable` answers false for
   * an unknown code, so a missing entry whose registry flag is false agreed
   * with the registry by accident. That is exactly how E_WHOLE_DOCUMENT — a
   * refusal the box sends today, for a route that would overwrite a whole
   * document — reached a reviewer as the app's shrug of a default sentence.
   */
  it('is the registry’s catalogue exactly, in both directions', () => {
    const declared = everyRegistryError()
      .map((e) => e.code)
      .sort()
    expect([...appErrorTable()].sort()).toEqual(declared)
  })

  it('answers the registry’s retryable for every code', () => {
    // The flag decides whether the app offers a retry at all, and it is what
    // the simulator puts on the wire — so a disagreement here is a simulator
    // that refuses differently than the box a phone will actually meet. The Go
    // cross-check already caught one: the simulator said E_UNAVAILABLE was not
    // retryable while the registry and the box both said it was.
    for (const { code, retryable } of everyRegistryError()) {
      expect(isRetryable(code), `${code} disagrees with the registry`).toBe(retryable)
    }
  })

  it('keeps what the box sends and what this app raises apart', () => {
    // The box generates its constants from the `errors` block alone. A code in
    // both blocks would be one the box could send and the app could invent,
    // and no reader could tell which had happened.
    const wire = new Set(registryErrors('errors').map((e) => e.code))
    for (const { code } of registryErrors('client_errors')) {
      expect(wire.has(code), `${code} is declared as both a wire and a client code`).toBe(false)
    }
  })
})

describe('scopes and roles', () => {
  it('are the registry’s, in the registry’s order', () => {
    expect([...SCOPES]).toEqual(registryScopes())
  })

  it('expand a role the way the registry writes it, with * meaning all', () => {
    const roles = registryRoles()
    expect(Object.keys(ROLE_SCOPES).sort()).toEqual(Object.keys(roles).sort())

    for (const [role, spec] of Object.entries(roles)) {
      const want = spec.scopes.includes('*') ? registryScopes() : spec.scopes
      expect([...(ROLE_SCOPES[role] ?? [])], `${role} carries the wrong scopes`).toEqual(want)
      expect(ROLE_LABELS[role], `${role} is labelled differently`).toBe(spec.label)
    }
  })
})

describe('command operations', () => {
  /**
   * The `ops` block is newer than the constants it pins. OP_SET_MODE and
   * OP_BATTERY_HOLD were hand-written here while the box hand-wrote the same
   * strings beside its dispatcher, and nothing compared the two — the exact
   * arrangement the registry exists to end. Set equality both ways: an op
   * this app can send that the registry has never heard of fails, and so
   * does a registry op this app cannot name.
   */
  it('are the registry’s ops exactly, in both directions', () => {
    const declared = registryOps()
      .map((o) => o.name)
      .sort()
    const constants = Object.values(appOps()).sort()
    expect(constants.length, 'no OP_ constants were found to check').toBeGreaterThan(0)
    expect(constants).toEqual(declared)
  })

  it('each demand a scope the registry declares', () => {
    // An op is a door and its scope is the key the box checks at it. An op
    // mapped to a scope that does not exist is a door no grant can ever open.
    const scopes = new Set(registryScopes())
    for (const { name, scope } of registryOps()) {
      expect(scopes.has(scope), `${name} demands ${scope}, which is not a registry scope`).toBe(
        true
      )
    }
  })

  it('demand the registry’s scope in the simulator playing the box', () => {
    // The simulator's OP_SCOPES is what every test in this tree meets as the
    // box's authorisation gate. The box's real table is checked against the
    // registry on its own side, so this pair of checks is what lets the two
    // tables disagree with each other only by first disagreeing with the
    // registry — which CI compares byte for byte.
    const declared = new Map(registryOps().map((o) => [o.name, o.scope]))
    const ops = appOps()
    const source = readFileSync(root('src/lib/sim/box.ts'), 'utf8')
    const table = source.slice(
      source.indexOf('const OP_SCOPES'),
      source.indexOf('}', source.indexOf('const OP_SCOPES'))
    )

    const entries = [...table.matchAll(/\[(OP_[A-Z_]+)\]:\s*'([^']+)'/g)]
    expect(entries.length, 'no ops were found in the simulator to check').toBe(declared.size)
    for (const [, constant, scope] of entries) {
      const wire = ops[constant!]
      expect(wire, `the simulator's ${constant} is not a constant in messages.ts`).toBeDefined()
      expect(scope, `the simulator demands ${scope} for ${wire}`).toBe(declared.get(wire!))
    }
  })
})

describe('frozen field ids', () => {
  /**
   * The registry froze these at v1 so an app of any age can draw the core
   * view from them alone. The app's copy is the FID table in
   * src/lib/format/explanation.ts, and it was the one shared table nothing
   * read back — a renumbering on the box side would have passed this
   * repository's CI. Id and name are checked as one pair, set equality both
   * ways: a swap, a rename, a fid dropped and a fid the app has no name for
   * all fail.
   */
  it('are the registry’s frozen_fields exactly, id and name together', () => {
    const declared = block('frozen_fields').map((line) => {
      const m = /^ {2}(\d+): \{ name: ([a-z0-9_]+),/.exec(line)
      expect(m, `unreadable frozen field line: ${line}`).not.toBeNull()
      return `${m![1]}: ${m![2]}`
    })
    const table = Object.entries(FID).map(([name, id]) => `${id}: ${name.toLowerCase()}`)
    expect(table.sort()).toEqual(declared.sort())
  })
})

describe('capabilities the app gates on', () => {
  /**
   * Every gate names its capability in one `CAP_` constant beside a comment
   * pointing at the registry, and this reads every constant so declared,
   * anywhere in the tree. The hand-written-names check below is what makes
   * the convention hold: a bare string inside `caps.has(...)` fails there,
   * so a name cannot dodge this check by never being declared. A capability
   * the registry has never heard of is a view that silently never appears,
   * which is also exactly what a box that legitimately lacks it looks like.
   */
  it('all exist in the registry, so nothing hides a feature over a typo', () => {
    const declared = new Set(registryCapabilities())

    let checked = 0
    for (const file of sourceFiles()) {
      for (const [, cap] of readFileSync(root(file), 'utf8').matchAll(
        /const CAP_[A-Z_]+ = '([^']+)'/g
      )) {
        checked += 1
        expect(declared.has(cap!), `${cap} in ${file} is not in contract/registry.yaml`).toBe(true)
      }
    }
    expect(checked, 'no capability names were found to check').toBeGreaterThan(0)
  })

  it('are all things the simulator could actually claim', () => {
    // The simulator's list is what every test in this tree meets as "a box".
    // One name in it the registry does not declare is an app built against a
    // capability no real box will ever send.
    const declared = new Set(registryCapabilities())
    const source = readFileSync(root('src/lib/sim/box.ts'), 'utf8')
    const list = source.slice(source.indexOf('const CAPS = ['), source.indexOf(']', source.indexOf('const CAPS = [')))

    for (const [, cap] of list.matchAll(/'([^']+)'/g)) {
      expect(declared.has(cap!), `the simulator claims ${cap}, which is not in the registry`).toBe(
        true
      )
    }
  })
})

describe('hand-written shared names', () => {
  /**
   * The checks above read constants, so a name only they can see is a name
   * that must live in one. This is the other half: a capability written
   * inline in `caps.has(...)` or a scope string written anywhere but the
   * contract is a name no check reads, and a rename in the registry would
   * sail past it. Grep-shaped on purpose — the convention it enforces is
   * lexical, and a parser would be a heavier tool giving the same answer.
   *
   * The simulator is the one exception. It plays the box, whose names are
   * generated from the registry, so its literals are compared against the
   * registry rather than banned — the same treatment its CAPS list gets.
   */
  it('appear only in the contract, or in the simulator playing the box', () => {
    // The scan can only ban a shape it recognises, so the shape is pinned to
    // the registry first: a declared scope it cannot match is a scope the
    // scan has gone blind to.
    const shape = /^ftw\.[a-z_]+\.(?:read|write)$/
    const declared = new Set(registryScopes())
    for (const scope of declared) {
      expect(scope, 'a registry scope the bare-name scan cannot recognise').toMatch(shape)
    }

    for (const file of sourceFiles()) {
      if (file === 'src/lib/protocol/contract.ts') continue
      const source = readFileSync(root(file), 'utf8')

      const caps = [...source.matchAll(/caps\.has\(\s*'([^']+)'/g)].map((m) => m[1]!)
      expect(
        caps,
        `${file} names a capability inline — declare it in a CAP_ constant so the registry check can see it`
      ).toEqual([])

      const scopes = [...source.matchAll(/'([^']+)'/g)]
        .map((m) => m[1]!)
        .filter((lit) => shape.test(lit))
      if (file.startsWith('src/lib/sim/')) {
        for (const lit of scopes) {
          expect(
            declared.has(lit),
            `the simulator uses ${lit} in ${file}, which is not in the registry`
          ).toBe(true)
        }
      } else {
        expect(
          scopes,
          `${file} hand-writes a scope — import it from src/lib/protocol/contract.ts`
        ).toEqual([])
      }
    }
  })
})
