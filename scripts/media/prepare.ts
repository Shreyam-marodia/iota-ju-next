/**
 * M03 media preflight.
 *
 * This command verifies masters from the pinned legacy checkout, records
 * checksums and probe metadata, and writes a delivery plan. It does not copy,
 * transcode, upload, overwrite, or delete media unless a future explicit
 * output mode is added.
 *
 * Usage:
 *   pnpm exec tsx scripts/media/prepare.ts \
 *     --source-root C:/path/to/old-iota-ju \
 *     --manifest data/migration/source-manifest.json
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const run = promisify(execFile)
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}

const SOURCE_ROOT = arg('source-root')
const MANIFEST_PATH = arg('manifest', 'data/migration/source-manifest.json') as string
const OUT = arg('out', 'data/migration/media-delivery-manifest.json') as string
const REPORT = arg('report', 'docs/media-preparation-report.md') as string
if (!SOURCE_ROOT) throw new Error('--source-root is required and must point to the pinned legacy checkout')

type SourceMedia = {
  url: string; filename: string; mime: string; bytes: number; sha256: string
  referencedBy: string[]; decision: string; reviewStatus?: string
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const rel = (u: string, base: string) => u.startsWith(base) ? u.slice(base.length) || '/' : u
const kb = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`

async function probe(file: string) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ])
    const j = JSON.parse(stdout)
    const stream = j.streams?.find((s: any) => ['video', 'image'].includes(s.codec_type))
    return {
      width: stream?.width,
      height: stream?.height,
      durationSec: j.format?.duration ? Number(Number(j.format.duration).toFixed(2)) : undefined,
      codec: stream?.codec_name,
    }
  } catch {
    return {}
  }
}

async function main() {
  const source = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const media = source.media as SourceMedia[]
  const base = source.baseUrl as string
  const entries: any[] = []

  for (const item of media) {
    const pathname = decodeURIComponent(new URL(item.url).pathname)
    const relativePath = pathname.replace(/^\/+/, '')
    const sourcePath = path.resolve(SOURCE_ROOT as string, relativePath)
    const record: any = {
      sourceUrl: item.url,
      sourcePath: relativePath,
      filename: item.filename,
      mime: item.mime,
      referencedBy: item.referencedBy,
      decision: item.decision,
      reviewStatus: item.reviewStatus ?? 'unreviewed',
      sourceVerified: false,
      deliveryStatus: 'planned',
      outputs: [],
    }
    try {
      await access(sourcePath)
      const bytes = await readFile(sourcePath)
      const metadata = await probe(sourcePath)
      record.sourceVerified = true
      record.bytes = bytes.length
      record.sha256 = sha256(bytes)
      Object.assign(record, metadata)
      record.plan = item.mime.startsWith('image/')
        ? 'Prepare responsive image renditions and an accessible alt-text review; preserve the master outside Git.'
        : item.mime.startsWith('video/')
          ? 'Prepare a poster and approved delivery encode; preserve the complete master outside Git.'
          : item.mime === 'application/pdf'
            ? 'Keep the report downloadable; preserve the original outside Git.'
            : 'Owner review required before preparing a delivery copy.'
      if (record.sha256 !== item.sha256 || record.bytes !== item.bytes)
        record.sourceDiscrepancy = 'Current checkout bytes/checksum differ from the M01 manifest.'
    } catch (error: any) {
      record.status = 'missing'
      record.error = error?.code === 'ENOENT' ? 'file-not-found' : String(error)
      record.plan = 'Do not prepare or upload; resolve the missing source file first.'
    }
    entries.push(record)
  }

  entries.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))
  const output = {
    sourceRevision: source.sourceRevision,
    sourceRepository: source.sourceRepository,
    sourceBaseUrl: base,
    mode: 'preflight-only',
    policy: 'No media binaries are written to this repository or uploaded to paid storage.',
    totals: {
      sourceMedia: entries.length,
      verified: entries.filter((e) => e.sourceVerified).length,
      missing: entries.filter((e) => e.status === 'missing').length,
      discrepancies: entries.filter((e) => e.sourceDiscrepancy).length,
      plannedOutputs: entries.reduce((n, e) => n + e.outputs.length, 0),
    },
    entries,
  }
  await mkdir(path.dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(output, null, 2) + '\n', 'utf8')

  const lines = [
    '# M03 media preparation report', '',
    `- Source revision: \`${source.sourceRevision}\``,
    `- Source repository: \`${source.sourceRepository}\``,
    '- Mode: **preflight-only**; no delivery binaries were created, uploaded, or added to Git.',
    `- Totals: ${output.totals.verified}/${output.totals.sourceMedia} verified; ${output.totals.missing} missing; ${output.totals.discrepancies} discrepancies; ${output.totals.plannedOutputs} planned outputs.`, '',
    '## Per-file verification', '',
    '| Source path | Type | Size | SHA-256 | Status | Plan |',
    '|---|---|---:|---|---|---|',
  ]
  for (const e of entries)
    lines.push(`| \`${esc(e.sourcePath)}\` | ${esc(e.mime)} | ${e.bytes ? kb(e.bytes) : '—'} | \`${e.sha256 ?? '—'}\` | ${e.sourceVerified ? 'verified' : e.status} | ${esc(e.plan)} |`)
  lines.push('', '## Release blockers', '', '- [ ] Approve the delivery/storage provider and budget before any upload.', '- [ ] Resolve every missing file and source discrepancy.', '- [ ] Review responsive image quality, video poster/codec, and report download behavior.', '- [ ] Run actual delivery-copy preparation only into an external, approved output directory.', '')
  await mkdir(path.dirname(REPORT), { recursive: true })
  await writeFile(REPORT, lines.join('\n'))
  console.log(`verified=${output.totals.verified} missing=${output.totals.missing} discrepancies=${output.totals.discrepancies} -> ${OUT}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
