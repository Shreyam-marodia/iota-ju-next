/**
 * Generates docs/source-inventory.md from the manifest. Deterministic (no
 * timestamps). Re-run after every inventory/decide run; edit the manifest,
 * not the generated tables. Hand-written notes go in docs/source-inventory-notes.md
 * (if present it is appended verbatim).
 *
 *   npx tsx scripts/content/inventory-doc.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > -1 ? process.argv[i + 1] : d
}
const MANIFEST = arg('manifest', 'data/migration/source-manifest.json')
const OUT = arg('out', 'docs/source-inventory.md')
const NOTES = 'docs/source-inventory-notes.md'

type R = {
  url: string; decision: string; reason: string; owner: string
  reviewStatus?: string
}
const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const status = (r: R) =>
  r.decision === 'unresolved' ? 'UNRESOLVED' : r.reviewStatus === 'proposed' ? `${r.decision} (proposed)` : r.decision
const rel = (u: string, base: string) => u.startsWith(base) ? u.slice(base.length) || '/' : u
const kb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB')

async function main() {
  const m = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const base: string = m.baseUrl
  const pages: any[] = m.pages, media: any[] = m.media, ext: any[] = m.externalEmbedsAndFiles
  const all: R[] = [...pages, ...media, ...ext]
  const L: string[] = []

  L.push('# Source inventory', '')
  L.push(`- Source revision: \`${m.sourceRevision}\``)
  L.push(`- Source repository: \`${m.sourceRepository}\``)
  L.push(`- Source lock: **${m.sourceLock?.status ?? 'unknown'}** — ${esc(m.sourceLock?.reason ?? '')}`)
  L.push(`- Provisional local source path: \`${m.sourcePath ?? '(not recorded)'}\``)
  L.push(`- Crawled from: \`${base}\` (local copy of the legacy site; URLs below are shown relative to it)`)
  L.push('- Generated from `data/migration/source-manifest.json`. Do not edit the tables by hand.', '')

  L.push('## Summary', '', '| Kind | Total | Unresolved | Proposed (unconfirmed) | Confirmed |', '|---|---|---|---|---|')
  for (const [name, list] of [['Pages', pages], ['Media files', media], ['External embeds/files', ext]] as [string, R[]][]) {
    const un = list.filter((r) => r.decision === 'unresolved').length
    const pr = list.filter((r) => r.decision !== 'unresolved' && r.reviewStatus === 'proposed').length
    L.push(`| ${name} | ${list.length} | ${un} | ${pr} | ${list.length - un - pr} |`)
  }
  L.push('', `Text blocks: ${(m.textBlocks ?? []).length}`, `Crawl review items: ${m.reviewItems.length}`, '')

  L.push('## Legacy services and explicit exclusions', '')
  for (const s of m.legacyServices ?? [])
    L.push(`- \`${esc(s.oldPath)}\` — **${esc(s.decision)}**: ${esc(s.reason)} Source: \`${esc(s.sourcePath)}\`.`)
  if (!(m.legacyServices ?? []).length) L.push('_None recorded._')
  L.push('')

  L.push('## Owner-review list', '',
    'Everything unresolved or still only proposed, grouped by who must decide.', '')
  const open = all.filter((r) => r.decision === 'unresolved' || r.reviewStatus === 'proposed')
  const owners = [...new Set(open.map((r) => r.owner || '(no owner yet)'))].sort()
  if (!owners.length) L.push('_Nothing open._', '')
  for (const o of owners) {
    const mine = open.filter((r) => (r.owner || '(no owner yet)') === o)
    L.push(`### ${o} (${mine.length})`, '')
    for (const r of mine.slice(0, 200)) L.push(`- \`${rel(r.url, base)}\` — ${status(r)}${r.reason ? ': ' + esc(r.reason) : ''}`)
    L.push('')
  }

  const excluded = all.filter((r) => r.decision === 'exclude')
  L.push('## Exclusions', '')
  if (!excluded.length) L.push('_None recorded yet. The workshop Q&A backend must be recorded here with an owner-approved old-URL response; the legacy service and data are not deleted._', '')
  for (const r of excluded) L.push(`- \`${rel(r.url, base)}\` — ${esc(r.reason)} (owner: ${r.owner || 'none'})`)
  if (excluded.length) L.push('')

  L.push('## Pages', '', '| Old URL | Title | Decision | Owner | Text chars | Media refs | Inbound | Reason |', '|---|---|---|---|---|---|---|---|')
  for (const p of pages)
    L.push(`| \`${esc(rel(p.url, base))}\` | ${esc(p.title)} | ${status(p)} | ${esc(p.owner)} | ${p.text.length} | ${p.media.length} | ${p.inboundFrom.length} | ${esc(p.reason)} |`)
  L.push('')

  L.push('## Media files', '',
    '| Filename | Type | Size | Dimensions / duration | SHA-256 (first 12) | Used on | Decision | Privacy | Owner |', '|---|---|---|---|---|---|---|---|---|')
  for (const f of media) {
    const dim = [f.width && f.height ? `${f.width}×${f.height}` : '', f.durationSec ? `${f.durationSec}s` : ''].filter(Boolean).join(', ')
    L.push(`| ${esc(f.filename)} | ${esc(f.mime)} | ${kb(f.bytes)} | ${dim} | \`${f.sha256.slice(0, 12)}\` | ${f.referencedBy.length} page(s) | ${status(f)} | ${f.privacy} | ${esc(f.owner)} |`)
  }
  L.push('')

  const dups = media.filter((f) => f.duplicateOf?.length)
  L.push('## Identical-content files (flagged, never merged)', '')
  if (!dups.length) L.push('_None._', '')
  for (const f of dups) L.push(`- ${esc(f.filename)} is byte-identical to: ${f.duplicateOf.map((u: string) => '`' + esc(rel(u, base)) + '`').join(', ')}`)
  if (dups.length) L.push('')

  L.push('## External embeds and files', '', '| URL | Used on | Decision | Owner |', '|---|---|---|---|')
  for (const e of ext) L.push(`| ${esc(e.url)} | ${e.referencedBy.map((u: string) => '`' + esc(rel(u, base)) + '`').join(', ')} | ${status(e)} | ${esc(e.owner)} |`)
  L.push('')

  L.push('## Manual trace checks', '', '| Section | Old URL | Source path | Result |', '|---|---|---|---|')
  for (const c of m.manualChecks ?? [])
    L.push(`| ${esc(c.section)} | \`${esc(rel(c.oldUrl, base))}\` | \`${esc(c.sourcePath)}\` | ${esc(c.result)} |`)
  L.push('')

  L.push('## Open questions and blockers', '', '| Category | Question | Owner |', '|---|---|---|')
  for (const q of m.openQuestions ?? []) L.push(`| ${esc(q.category)} | ${esc(q.question)} | ${esc(q.owner)} |`)
  L.push('')

  L.push('## Crawl review items', '')
  if (!m.reviewItems.length) L.push('_None reported by the crawler. This does not prove the site is clean: see the manual checks below._', '')
  for (const r of m.reviewItems) L.push(`- **${esc(r.kind)}** \`${esc(r.url)}\` ${esc(r.detail)}`)
  L.push('')

  L.push('## Manual checks (the crawler cannot find these)', '',
    '- [ ] Duplicate or same-name people',
    '- [ ] Questionable dates and statuses',
    '- [ ] Stale event actions (expired Register Now / Live Portal)',
    '- [ ] Unavailable external links and missing files',
    '- [ ] Content built by JavaScript or CSS backgrounds that the crawler missed',
    '- [ ] Workshop Q&A backend recorded as excluded, with an approved old-URL response',
    '- [ ] Official contact address kept: iotajuofficial@gmail.com', '')

  try { L.push('## Notes', '', (await readFile(NOTES, 'utf8')).trim(), '') } catch { /* optional */ }

  await mkdir(path.dirname(OUT), { recursive: true })
  await writeFile(OUT, L.join('\n'))
  console.log(`wrote ${OUT}: ${pages.length} pages, ${media.length} media, ${open.length} open items`)
}
main().catch((e) => { console.error(e); process.exit(1) })
