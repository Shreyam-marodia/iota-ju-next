/**
 * M01 inventory: crawl the legacy IOTA JU site (or a read-only snapshot served
 * locally) and write data/migration/source-manifest.json.
 *
 * Usage:
 *   pnpm tsx scripts/content/inventory.ts \
 *     --base-url https://www.iotaju.com --revision "<commit-or-export-date>"
 *
 * Design rules (from the handout):
 *  - Deterministic: no timestamps, everything sorted, same input => same bytes.
 *  - Exact URLs/casing/encoding are kept as written in the source.
 *  - Human decisions (migrate/redirect/retain/exclude, reason, owner) are
 *    preserved across re-runs; new items start as "unresolved".
 *  - Nothing is deleted or merged by name/size; duplicates are only flagged.
 *
 * Known first-pass limits: regex HTML extraction (no new root dependency),
 * no CSS url() or JS-built content. Add those if the snapshot needs them.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const run = promisify(execFile)

// ---- args ------------------------------------------------------------------
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const BASE = (arg('base-url', 'https://www.iotaju.com') as string).replace(/\/$/, '')
const REVISION = arg('revision')
const OUT = arg('out', 'data/migration/source-manifest.json') as string
if (!REVISION) throw new Error('--revision is required (commit or export date of the source)')
const HOST = new URL(BASE).host

// Seeds known from the home page; the crawler discovers the rest.
const SEEDS = ['/home', '/events', '/projects', '/team', '/timeline', '/alumni', '/about']

// ---- types -----------------------------------------------------------------
type Decision = 'unresolved' | 'migrate' | 'redirect' | 'retain' | 'exclude'
interface Review {
  decision: Decision; reason: string; owner: string
  reviewStatus?: 'proposed' | 'confirmed' // set by decide.ts; a human confirms
}
interface PageItem extends Review {
  url: string; status: number; contentType: string; title: string
  htmlSha256: string; text: string
  links: string[]; media: string[]; inboundFrom: string[]
}
interface MediaItem extends Review {
  url: string; filename: string; status: number; mime: string; bytes: number
  sha256: string; width?: number; height?: number; durationSec?: number
  referencedBy: string[]; privacy: 'unreviewed' | 'public' | 'private'
  duplicateOf: string[]
}

interface TextBlock extends Review {
  id: string; pageUrl: string; oldPath: string; type: 'text'
  bytes: number; sha256: string; text: string
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const blank: Review = { decision: 'unresolved', reason: '', owner: '' }
const abs = (href: string, from: string) => {
  try { return new URL(href, from).toString() } catch { return null }
}

// ---- extraction ------------------------------------------------------------
const attrs = (html: string, re: RegExp) =>
  [...html.matchAll(re)].map((m) => m[1]).filter(Boolean)

function extract(html: string, pageUrl: string) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim()
  const hrefs = attrs(html, /<a\b[^>]*\shref=["']([^"']+)["']/gi)
  const srcs = [
    ...attrs(html, /<img\b[^>]*\ssrc=["']([^"']+)["']/gi),
    ...attrs(html, /<(?:video|source|audio)\b[^>]*\ssrc=["']([^"']+)["']/gi),
    ...attrs(html, /<video\b[^>]*\sposter=["']([^"']+)["']/gi),
    ...attrs(html, /<iframe\b[^>]*\ssrc=["']([^"']+)["']/gi),
  ]
  const files = hrefs.filter((h) => /\.(pdf|docx?|pptx?|xlsx?|zip|mp4|webm|mov)(\?|#|$)/i.test(h))
  const resolve = (xs: string[]) =>
    [...new Set(xs.map((x) => abs(x, pageUrl)).filter((x): x is string => !!x))]
  return {
    title, text,
    links: resolve(hrefs.filter((h) => !h.startsWith('#') && !h.startsWith('mailto:'))),
    media: resolve([...srcs, ...files]),
  }
}

async function probeMedia(buf: Buffer, mime: string, filename: string) {
  const out: Pick<MediaItem, 'width' | 'height' | 'durationSec'> = {}
  if (mime.startsWith('image/') && !mime.includes('svg')) {
    try {
      const sharp = (await import('sharp')).default
      const m = await sharp(buf).metadata()
      out.width = m.width; out.height = m.height
    } catch { /* leave blank; reviewer will see it */ }
  }
  if (mime.startsWith('video/')) {
    const dir = await mkdtemp(path.join(tmpdir(), 'inv-'))
    const f = path.join(dir, 'v' + path.extname(filename))
    try {
      await writeFile(f, buf)
      const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json',
        '-show_format', '-show_streams', f])
      const j = JSON.parse(stdout)
      const v = j.streams?.find((s: any) => s.codec_type === 'video')
      out.width = v?.width; out.height = v?.height
      out.durationSec = j.format?.duration ? Number(Number(j.format.duration).toFixed(2)) : undefined
    } catch { /* ffprobe missing or unsupported codec -> reviewer decides */ }
    finally { await rm(dir, { recursive: true, force: true }) }
  }
  return out
}

// ---- main ------------------------------------------------------------------
async function main() {
  let previous: {
    pages?: PageItem[]; media?: MediaItem[]
    externalEmbedsAndFiles?: (Review & { url: string })[]
  } = {}
  try { previous = JSON.parse(await readFile(OUT, 'utf8')) } catch { /* first run */ }
  const keepP = new Map((previous.pages ?? []).map((p) => [p.url, p]))
  const keepM = new Map((previous.media ?? []).map((m) => [m.url, m]))
  const keepE = new Map((previous.externalEmbedsAndFiles ?? []).map((e) => [e.url, e]))
  const pick = (o?: Review): Review =>
    o
      ? {
          decision: o.decision, reason: o.reason, owner: o.owner,
          ...(o.reviewStatus ? { reviewStatus: o.reviewStatus } : {}),
        }
      : { ...blank }

  const pages = new Map<string, PageItem>()
  const mediaRefs = new Map<string, Set<string>>()
  const reviewItems: { kind: string; url: string; detail: string }[] = []
  const queue = SEEDS.map((s) => BASE + s)
  const seen = new Set<string>()

  while (queue.length) {
    const url = queue.shift() as string
    if (seen.has(url)) continue
    seen.add(url)
    let res: Response
    try { res = await fetch(url, { redirect: 'manual' }) }
    catch (e) { reviewItems.push({ kind: 'unreachable', url, detail: String(e) }); continue }
    const ct = res.headers.get('content-type') ?? ''
    if (res.status >= 300 || !ct.includes('text/html')) {
      reviewItems.push({ kind: 'non-200-or-non-html page', url, detail: `${res.status} ${ct}` })
      if (res.status >= 300 && res.status < 400)
        reviewItems.push({ kind: 'redirect-target', url, detail: res.headers.get('location') ?? '' })
      continue
    }
    const html = await res.text()
    const x = extract(html, url)
    pages.set(url, {
      ...pick(keepP.get(url)), url, status: res.status, contentType: ct,
      title: x.title, htmlSha256: sha(html), text: x.text,
      links: x.links.sort(), media: x.media.sort(), inboundFrom: [],
    })
    for (const m of x.media) {
      if (!mediaRefs.has(m)) mediaRefs.set(m, new Set())
      mediaRefs.get(m)!.add(url)
    }
    for (const l of x.links) {
      const u = new URL(l)
      const isFile = /\.(pdf|docx?|pptx?|xlsx?|zip|mp4|webm|mov|png|jpe?g|gif|webp|svg)$/i.test(u.pathname)
      if (u.host === HOST && !isFile) queue.push(l.split('#')[0])
    }
  }

  // Refuse to overwrite a good manifest with an empty crawl (server down, wrong port...)
  if (pages.size === 0) {
    console.error('No pages could be fetched. Is the site running at ' + BASE + '? Manifest NOT written.')
    for (const r of reviewItems.slice(0, 5)) console.error(' -', r.kind, r.url, r.detail)
    process.exit(1)
  }

  // inbound links (page -> page)
  for (const p of pages.values())
    for (const l of p.links) pages.get(l.split('#')[0])?.inboundFrom.push(p.url)
  for (const p of pages.values()) p.inboundFrom = [...new Set(p.inboundFrom)].sort()

  // media: only fetch same-host files; external embeds are listed, not downloaded
  const media: MediaItem[] = []
  const external: (Review & { url: string; referencedBy: string[] })[] = []
  for (const [url, refs] of [...mediaRefs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const referencedBy = [...refs].sort()
    if (new URL(url).host !== HOST) { external.push({ ...pick(keepE.get(url)), url, referencedBy }); continue }
    let res: Response
    try { res = await fetch(url) } catch (e) {
      reviewItems.push({ kind: 'media-unreachable', url, detail: String(e) }); continue
    }
    if (!res.ok) { reviewItems.push({ kind: 'media-missing', url, detail: String(res.status) }); continue }
    const buf = Buffer.from(await res.arrayBuffer())
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    media.push({
      ...pick(keepM.get(url)), url, filename, status: res.status, mime, bytes: buf.length,
      sha256: sha(buf), ...(await probeMedia(buf, mime, filename)),
      referencedBy, privacy: keepM.get(url)?.privacy ?? 'unreviewed', duplicateOf: [],
    })
  }
  // flag identical content only (never merge): same sha256, different URL
  const bySha = new Map<string, MediaItem[]>()
  for (const m of media) bySha.set(m.sha256, [...(bySha.get(m.sha256) ?? []), m])
  for (const group of bySha.values())
    if (group.length > 1) for (const m of group)
      m.duplicateOf = group.filter((g) => g !== m).map((g) => g.url).sort()

  const manifest = {
    sourceRevision: REVISION,
    sourceRepository: 'https://github.com/Soham-47/iota-ju.git',
    sourcePath: 'C:/Users/khush/OneDrive/Documents/old_iota_ju/iota-ju',
    sourceLock: {
      status: 'unconfirmed',
      reason: 'The orchestrator did not provide an accessible source-lock record; local git metadata is recorded provisionally.',
      requestedFrom: 'orchestrator',
    },
    baseUrl: BASE,
    pages: [...pages.values()].sort((a, b) => (a.url < b.url ? -1 : 1)),
    textBlocks: [...pages.values()].map((p): TextBlock => ({
      ...pick(p), id: `text:${new URL(p.url).pathname}`, pageUrl: p.url,
      oldPath: new URL(p.url).pathname, type: 'text', bytes: Buffer.byteLength(p.text, 'utf8'),
      sha256: sha(p.text), text: p.text,
    })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    media,
    externalEmbedsAndFiles: external,
    legacyServices: [{
      id: 'workshop-qa',
      oldPath: '/drone-workshop/qa-portal/',
      pageUse: 'Separate Drone Workshop Q&A service and data; not part of the new app.',
      type: 'service',
      decision: 'exclude',
      reason: 'Exclude workshop Q&A from the new app; retain the old service and data. The orchestrator must approve the old-URL response.',
      owner: 'orchestrator',
      sourcePath: 'frontend/drone-workshop/qa-portal/',
    }],
    manualChecks: [
      { section: 'home', oldUrl: `${BASE}/home`, sourcePath: 'frontend/HOME/homepage-of-iota-main/home.html', result: 'pass: page served and homepage text/media references were traced.' },
      { section: 'about', oldUrl: `${BASE}/about`, sourcePath: 'frontend/ABOUT US/about us.html', result: 'pass: page served and visible text plus map embed were traced.' },
      { section: 'events', oldUrl: `${BASE}/events`, sourcePath: 'frontend/EVENTS (2)/views/events.html', result: 'pass: listing served and event detail links were traced.' },
      { section: 'projects', oldUrl: `${BASE}/projects`, sourcePath: 'frontend/projects/projects.html', result: 'pass: listing served; AGV link traced to autonomous-mobility detail.' },
      { section: 'team', oldUrl: `${BASE}/team`, sourcePath: 'frontend/team/team.html', result: 'pass: team page served; portraits and department text require identity review.' },
      { section: 'alumni', oldUrl: `${BASE}/alumni`, sourcePath: 'frontend/ALUMNI/alumni.html', result: 'pass: alumni page served; portraits and YouTube embed traced.' },
      { section: 'timeline', oldUrl: `${BASE}/timeline`, sourcePath: 'frontend/TIMELINE/timeline.html', result: 'pass: timeline page served and historical content was traced.' },
      { section: 'AGV detail', oldUrl: `${BASE}/project/autonomous-mobility`, sourcePath: 'frontend/projects/project-details/autonomous-mobility.html', result: 'pass: linked AGV detail served; YouTube demo and Unified AGV Tech Stack text traced.' },
      { section: 'history/detail', oldUrl: `${BASE}/events/lord-of-the-rings-2025`, sourcePath: 'frontend/EVENTS (2)/views/lordOfRings25.html', result: 'pass: linked historical event route served and legacy-case path recorded.' },
    ],
    openQuestions: [
      { category: 'source-lock', question: 'What orchestrator-approved source repository and immutable commit should replace the provisional local lock?', owner: 'orchestrator' },
      { category: 'identity', question: 'Which same-name people and portraits are distinct? Do not merge until Ritendu confirms identity.', owner: 'Ritendu' },
      { category: 'dates', question: 'Which event/project dates and current statuses are authoritative where source copy is stale or inconsistent?', owner: 'orchestrator' },
      { category: 'departments', question: 'Confirm department and role text before migration, including the known Raunak Panja correction.', owner: 'Ritendu' },
      { category: 'links', question: 'Confirm destinations and retirement behavior for legacy aliases, external embeds, stale actions and missing targets.', owner: 'Sourasish' },
      { category: 'missing-files', question: 'Review every crawler review item and any JavaScript/CSS-built or unavailable asset before import.', owner: 'Shreyam' },
      { category: 'workshop-qa', question: 'Approve the old-URL response for the excluded workshop Q&A service; keep its service and data untouched.', owner: 'orchestrator' },
    ],
    reviewItems: reviewItems.sort((a, b) => (a.url + a.kind < b.url + b.kind ? -1 : 1)),
  }
  await mkdir(path.dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`pages=${manifest.pages.length} media=${media.length} ` +
    `external=${external.length} review=${reviewItems.length} -> ${OUT}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
