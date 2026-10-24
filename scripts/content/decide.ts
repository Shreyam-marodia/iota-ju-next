/**
 * Proposes decisions for manifest items that are still "unresolved".
 * It never overwrites a decision a human already made, and everything it
 * writes is marked reviewStatus: "proposed" until a person confirms it.
 *
 *   npx tsx scripts/content/decide.ts --qa-pattern "workshop|q-?and-?a|qna"
 *   # review data/migration/source-manifest.json (or docs/source-inventory.md)
 *   npx tsx scripts/content/decide.ts --confirm-proposed
 *
 * Owners use the roles in the handout: orchestrator (content ambiguity,
 * exclusions), Ritendu (people identity), Sourasish (redirects), Shreyam
 * (media/inventory). Change them below if your team assigns differently.
 */
import { readFile, writeFile } from 'node:fs/promises'

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > -1 ? process.argv[i + 1] : d
}
const MANIFEST = arg('manifest', 'data/migration/source-manifest.json') as string
const QA = arg('qa-pattern') ? new RegExp(arg('qa-pattern') as string, 'i') : null
const CONFIRM = process.argv.includes('--confirm-proposed')

type Item = {
  url: string; decision: string; reason: string; owner: string
  reviewStatus?: 'proposed' | 'confirmed'
  referencedBy?: string[]; mime?: string; duplicateOf?: string[]
}
const pathOf = (u: string) => new URL(u).pathname
const propose = (it: Item, decision: string, reason: string, owner: string) => {
  it.decision = decision; it.reason = reason; it.owner = owner
  it.reviewStatus = 'proposed'
}

async function main() {
  const m = JSON.parse(await readFile(MANIFEST, 'utf8'))

  if (CONFIRM) {
    let n = 0
    for (const list of [m.pages, m.media, m.externalEmbedsAndFiles] as Item[][])
      for (const it of list)
        if (it.reviewStatus === 'proposed') { it.reviewStatus = 'confirmed'; n++ }
    await writeFile(MANIFEST, JSON.stringify(m, null, 2) + '\n')
    console.log(`confirmed ${n} proposed decisions`)
    return
  }

  const isQa = (u: string) => !!QA && QA.test(pathOf(u))
  const isPeople = (u: string) => /^\/(team|alumni)(\/|$)/i.test(pathOf(u))

  for (const p of m.pages as Item[]) {
    if (p.decision !== 'unresolved') continue
    if (isQa(p.url))
      propose(p, 'exclude',
        'Workshop Q&A backend is not part of the new app. Needs an owner-approved ' +
        'old-URL response; legacy service and data are retained, not deleted.',
        'orchestrator')
    else if (isPeople(p.url))
      propose(p, 'migrate',
        'People page. Same-name entries stay separate until identity review. ' +
        'Old URL destination to be set for the redirect runtime.',
        'Ritendu')
    else
      propose(p, 'migrate',
        'Public page; content moves to the CMS. Old URL destination to be ' +
        'recorded for the redirect runtime.',
        'orchestrator')
  }

  for (const f of m.media as Item[]) {
    if (f.decision !== 'unresolved') continue
    const refs = f.referencedBy ?? []
    const onlyQa = !!QA && refs.length > 0 && refs.every(isQa)
    const onPeople = refs.some(isPeople)
    const dup = f.duplicateOf?.length
      ? ` Same SHA-256 as ${f.duplicateOf.length} other file(s); do not merge without review.`
      : ''
    if (onlyQa)
      propose(f, 'exclude', 'Only referenced by the excluded Q&A pages. Keep the original; do not delete.' + dup, 'orchestrator')
    else if (f.mime === 'application/pdf')
      propose(f, 'migrate', 'Report/document; must stay downloadable.' + dup, 'Shreyam')
    else if (f.mime?.startsWith('video/'))
      propose(f, 'migrate', 'Keep the complete source video; delivery copy prepared separately.' + dup, 'Shreyam')
    else if (f.mime?.startsWith('image/'))
      propose(f, 'migrate',
        (onPeople ? 'Portrait/people image; privacy and consent to be confirmed. ' : 'Referenced by migrated page(s). ') + dup.trim(),
        onPeople ? 'Ritendu' : 'Shreyam')
    // anything else stays unresolved on purpose
  }

  for (const e of m.externalEmbedsAndFiles as Item[]) {
    if (e.decision && e.decision !== 'unresolved') continue
    if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|drive\.google\.com|docs\.google\.com)$/i.test(new URL(e.url).host))
      propose(e, 'retain', 'External embed/file; keep as an approved embed. Check it is still available.', 'orchestrator')
    else
      propose(e, 'retain', `External asset/embed from ${new URL(e.url).host}; keep only after link, license and availability review.`, 'orchestrator')
  }

  await writeFile(MANIFEST, JSON.stringify(m, null, 2) + '\n')
  const count = (xs: Item[]) => {
    const c: Record<string, number> = {}
    for (const x of xs) {
      const k = `${x.decision}${x.reviewStatus ? '/' + x.reviewStatus : ''}`
      c[k] = (c[k] ?? 0) + 1
    }
    return JSON.stringify(c)
  }
  console.log('pages   ', count(m.pages))
  console.log('media   ', count(m.media))
  console.log('external', count(m.externalEmbedsAndFiles))
}
main().catch((e) => { console.error(e); process.exit(1) })
