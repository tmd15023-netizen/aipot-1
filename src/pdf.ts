import { getDocument, GlobalWorkerOptions, PasswordResponses } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { OutlineEntry } from './types.ts'

GlobalWorkerOptions.workerSrc = workerUrl

const passwords = new Map<string, string>()
let askPassword: (wrong: boolean) => Promise<string | null> = async () => null

export function setPasswordAsker(fn: (wrong: boolean) => Promise<string | null>) {
  askPassword = fn
}

export function passwordFor(id: string) {
  return passwords.get(id) ?? null
}

export function rememberPassword(id: string, password: string) {
  passwords.set(id, password)
}

export function cleanText(value: unknown) {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
}

export function titleFromName(name: string) {
  const base = cleanText(name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' '))
  return base || '제목 없는 책'
}

export function usableTitle(value: unknown, fallback: string) {
  const clean = cleanText(value)
  if (!clean) return fallback
  if (/\uFFFD/.test(clean)) return fallback
  if (/^(untitled|undefined|no title)$/i.test(clean)) return fallback
  return clean
}

export function isPdf(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

export function isImage(file: File) {
  return /^image\/(jpeg|png|webp|gif)$/.test(file.type) || /\.(jpe?g|png|webp|gif)$/i.test(file.name)
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image'))
    image.src = src
  })
}

export async function imageFileToCover(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const maxEdge = 2200
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.92)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function isCancelled(err: unknown) {
  return err instanceof Error && err.name === 'CancelledError'
}

export function isQuota(err: unknown) {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
}

export function friendlyOpenError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/worker|fake worker/i.test(msg)) {
    return 'PDF 엔진을 시작하지 못했습니다. 개발 서버 주소로 열어 주세요.'
  }
  return '이 PDF를 열 수 없습니다.'
}

export async function openPdf(data: ArrayBuffer, password?: string | null) {
  const task = getDocument({
    data,
    password: password || undefined,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/standard_fonts/',
    useSystemFonts: true,
  })
  let used = password || null
  let aborted = false
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const wrong = reason === PasswordResponses.INCORRECT_PASSWORD
    void askPassword(wrong).then((pw) => {
      if (!pw) {
        aborted = true
        try { task.destroy() } catch { /* ignore */ }
        return
      }
      used = pw
      update(pw)
    })
  }
  try {
    const pdf = await task.promise
    return { pdf, password: used }
  } catch (err) {
    if (aborted) {
      const cancel = new Error('cancelled')
      cancel.name = 'CancelledError'
      throw cancel
    }
    throw err
  }
}

export async function makeCover(pdf: PDFDocumentProxy) {
  const page = await pdf.getPage(1)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: 420 / base.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return ''
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas.toDataURL('image/jpeg', 0.82)
}

export function flattenOutline(items: unknown, depth = 0, acc: OutlineEntry[] = []) {
  if (!Array.isArray(items)) return acc
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const node = item as { title?: string; dest?: unknown; items?: unknown }
    acc.push({ title: node.title || '제목 없음', dest: node.dest ?? null, depth })
    flattenOutline(node.items, depth + 1, acc)
  }
  return acc
}

export async function destToPage(pdf: PDFDocumentProxy, dest: unknown) {
  if (!dest) return null
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    if (!Array.isArray(explicit) || explicit[0] == null) return null
    const index = await pdf.getPageIndex(explicit[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0])
    return index + 1
  } catch (err) {
    console.error(err)
    return null
  }
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
