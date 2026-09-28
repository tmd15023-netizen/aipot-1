import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { BookRecord, OutlineEntry, ReaderSettings, ThemeName } from './types.ts'
import {
  clamp,
  destToPage,
  flattenOutline,
  friendlyOpenError,
  isCancelled,
  loadImage,
  openPdf,
  passwordFor,
  rememberPassword,
} from './pdf.ts'

type ReaderProps = {
  book: BookRecord
  blob: Blob
  settings: ReaderSettings
  onSettings: (next: ReaderSettings) => void
  onClose: () => void
  onChange: (book: BookRecord) => void
  onToast: (message: string) => void
}

type RenderJob = { cancel: () => void }

function visiblePages(page: number, total: number, spread: boolean, wide: boolean, hasCover: boolean) {
  const min = hasCover ? 0 : 1
  const current = clamp(page, min, Math.max(total, 1))
  if (current === 0) return [0]
  if (!spread || !wide || total < 1) return [current]
  const left = current % 2 === 1 ? current : current - 1
  const pages = [left]
  if (left + 1 <= total) pages.push(left + 1)
  return pages
}

function formatPage(page: number) {
  return page === 0 ? '표지' : String(page)
}

export default function Reader({ book, blob, settings, onSettings, onClose, onChange, onToast }: ReaderProps) {
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLCanvasElement>(null)
  const rightRef = useRef<HTMLCanvasElement>(null)
  const helpRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const tokenRef = useRef(0)
  const jobsRef = useRef<RenderJob[]>([])
  const recordRef = useRef(book)
  const startPage = useRef(book.lastPage ?? (book.customCover ? 0 : 1))
  const gesture = useRef<{ x: number; y: number; id: number } | null>(null)

  const [record, setRecord] = useState(book)
  const [page, setPage] = useState(book.lastPage ?? (book.customCover ? 0 : 1))
  const [total, setTotal] = useState(book.totalPages || 1)
  const [ready, setReady] = useState(false)
  const [painting, setPainting] = useState(false)
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [drawer, setDrawer] = useState<null | 'toc' | 'marks'>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [full, setFull] = useState(false)
  const [wide, setWide] = useState(() => window.innerWidth >= 860)
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 })

  recordRef.current = record
  const hasCover = Boolean(record.customCover && record.coverUrl)
  const pages = visiblePages(page, total, settings.spread, wide, hasCover)
  const marked = record.bookmarks.some((item) => item.page === page)
  const rangeLabel = pages.length === 2
    ? `${formatPage(pages[0] ?? 1)}–${formatPage(pages[1] ?? 1)}`
    : formatPage(pages[0] ?? 1)
  const atStart = (pages[0] ?? 1) <= (hasCover ? 0 : 1)
  const atEnd = (pages[pages.length - 1] ?? 1) >= total

  useEffect(() => {
    document.title = `${book.title} — 전자책`
    return () => {
      document.title = '전자책'
    }
  }, [book.title])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const data = await blob.arrayBuffer()
        if (!alive) return
        const opened = await openPdf(data, passwordFor(book.id))
        if (!alive) {
          opened.pdf.destroy()
          return
        }
        if (opened.password) rememberPassword(book.id, opened.password)
        pdfRef.current = opened.pdf
        const nextOutline = flattenOutline(await opened.pdf.getOutline())
        if (!alive) return
        const totalPages = opened.pdf.numPages
        const minPage = book.customCover && book.coverUrl ? 0 : 1
        const start = clamp(startPage.current, minPage, totalPages)
        setOutline(nextOutline)
        setTotal(totalPages)
        setPage(start)
        setRecord((current) => ({
          ...current,
          totalPages,
          lastPage: start,
          bookmarks: Array.isArray(current.bookmarks) ? current.bookmarks : [],
        }))
        setReady(true)
      } catch (err) {
        if (!alive) return
        if (!isCancelled(err)) onToast(friendlyOpenError(err))
        onClose()
      }
    }
    void load()
    return () => {
      alive = false
      tokenRef.current += 1
      for (const job of jobsRef.current) {
        try { job.cancel() } catch { /* ignore */ }
      }
      pdfRef.current?.destroy()
      pdfRef.current = null
    }
  }, [blob, book.id, onClose, onToast])

  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => onChange(recordRef.current), 200)
    return () => window.clearTimeout(timer)
  }, [record, ready, onChange])

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 860)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const w = Math.round(stage.clientWidth)
      const h = Math.round(stage.clientHeight)
      setStageBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    measure()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const pdf = pdfRef.current
    const stage = stageRef.current
    if (!pdf || !ready || !stage || stageBox.w < 40) return
    const token = ++tokenRef.current
    for (const job of jobsRef.current) {
      try { job.cancel() } catch { /* ignore */ }
    }
    jobsRef.current = []
    let alive = true
    const slow = window.setTimeout(() => {
      if (alive && token === tokenRef.current) setPainting(true)
    }, 140)

    const run = async () => {
      try {
        const shown = visiblePages(page, pdf.numPages, settings.spread, wide, Boolean(recordRef.current.customCover && recordRef.current.coverUrl))
        if (shown.length === 1 && shown[0] === 0 && recordRef.current.coverUrl) {
          const image = await loadImage(recordRef.current.coverUrl)
          if (!alive || token !== tokenRef.current) return
          const padX = 56
          const padY = 32
          const gutter = 16
          const boxW = Math.max(80, stage.clientWidth - padX - gutter)
          const boxH = Math.max(80, stage.clientHeight - padY - gutter)
          let coverScale = settings.fit === 'width'
            ? boxW / image.width
            : Math.min(boxW / image.width, boxH / image.height)
          coverScale = Math.max(0.1, coverScale * settings.zoom)
          const cssW = Math.max(1, Math.round(image.width * coverScale))
          const cssH = Math.max(1, Math.round(image.height * coverScale))
          const canvas = rightRef.current
          if (slotRef.current) {
            slotRef.current.style.width = `${Math.max(stage.clientWidth, cssW + 48)}px`
            slotRef.current.style.height = `${Math.max(stage.clientHeight, cssH + 32)}px`
          }
          if (canvas) {
            const dpr = Math.min(window.devicePixelRatio || 1, 2, 2200 / cssW)
            const bufW = Math.max(1, Math.round(cssW * dpr))
            const bufH = Math.max(1, Math.round(cssH * dpr))
            const ctx = canvas.getContext('2d', { alpha: false })
            if (ctx) {
              if (canvas.width !== bufW || canvas.height !== bufH) {
                canvas.width = bufW
                canvas.height = bufH
              }
              canvas.style.width = `${cssW}px`
              canvas.style.height = `${cssH}px`
              ctx.fillStyle = '#ffffff'
              ctx.fillRect(0, 0, bufW, bufH)
              ctx.drawImage(image, 0, 0, bufW, bufH)
            }
          }
          return
        }
        const padX = 56
        const padY = 32
        const gutter = 16
        const innerW = Math.max(80, stage.clientWidth - padX - gutter)
        const innerH = Math.max(80, stage.clientHeight - padY - gutter)
        const two = shown.length === 2
        const boxW = Math.max(80, innerW / shown.length - (two ? 16 : 8))
        const boxH = Math.max(80, innerH - 8)
        const first = await pdf.getPage(shown[0]!)
        if (!alive || token !== tokenRef.current) return
        const base = first.getViewport({ scale: 1 })
        let scale = settings.fit === 'width'
          ? boxW / base.width
          : Math.min(boxW / base.width, boxH / base.height)
        scale = Math.max(0.1, scale * settings.zoom)
        const pagesToPaint: Array<[HTMLCanvasElement | null, number]> = [
          [rightRef.current, two ? shown[1]! : shown[0]!],
        ]
        if (two) pagesToPaint.unshift([leftRef.current, shown[0]!])
        const painted: Array<{ canvas: HTMLCanvasElement; viewport: ReturnType<typeof first.getViewport>; pdfPage: typeof first }> = []
        for (const [canvas, pageNumber] of pagesToPaint) {
          if (!canvas || !alive || token !== tokenRef.current) continue
          const pdfPage = pageNumber === shown[0] ? first : await pdf.getPage(pageNumber)
          if (!alive || token !== tokenRef.current) return
          painted.push({ canvas, pdfPage, viewport: pdfPage.getViewport({ scale }) })
        }
        const bookW = painted.reduce((sum, item) => sum + Math.round(item.viewport.width), 0) + (painted.length === 2 ? 14 : 0)
        const bookH = painted.reduce((max, item) => Math.max(max, Math.round(item.viewport.height)), 0)
        if (slotRef.current) {
          slotRef.current.style.width = `${Math.max(stage.clientWidth, bookW + 48)}px`
          slotRef.current.style.height = `${Math.max(stage.clientHeight, bookH + 32)}px`
        }
        await Promise.all(painted.map(async ({ canvas, pdfPage, viewport }) => {
          const cssW = Math.max(1, Math.round(viewport.width))
          const cssH = Math.max(1, Math.round(viewport.height))
          const dpr = Math.min(window.devicePixelRatio || 1, 2, 2200 / cssW)
          const bufW = Math.max(1, Math.round(cssW * dpr))
          const bufH = Math.max(1, Math.round(cssH * dpr))
          const ctx = canvas.getContext('2d', { alpha: false })
          if (!ctx || !alive || token !== tokenRef.current) return
          if (canvas.width !== bufW || canvas.height !== bufH) {
            canvas.width = bufW
            canvas.height = bufH
          }
          canvas.style.width = `${cssW}px`
          canvas.style.height = `${cssH}px`
          const task = pdfPage.render({
            canvasContext: ctx,
            viewport,
            transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
          })
          jobsRef.current.push(task)
          try {
            await task.promise
          } catch (err) {
            const name = err instanceof Error ? err.name : ''
            if (name !== 'RenderingCancelledException' && name !== 'AbortException') throw err
          }
        }))
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        if (!alive || token !== tokenRef.current || name === 'RenderingCancelledException') return
        console.error(err)
        onToast('페이지를 그리지 못했습니다.')
      } finally {
        window.clearTimeout(slow)
        if (token === tokenRef.current) setPainting(false)
      }
    }
    void run()
    return () => {
      alive = false
      window.clearTimeout(slow)
    }
  }, [page, ready, settings.fit, settings.spread, settings.zoom, stageBox, total, wide, onToast])

  useEffect(() => {
    const onFull = () => setFull(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onFull)
    return () => document.removeEventListener('fullscreenchange', onFull)
  }, [])

  useEffect(() => {
    if (!helpOpen) return
    const close = (event: MouseEvent) => {
      if (helpRef.current?.contains(event.target as Node)) return
      setHelpOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [helpOpen])

  function commit(nextPage: number, nextRecord = recordRef.current) {
    const minPage = nextRecord.customCover && nextRecord.coverUrl ? 0 : 1
    const pageNo = clamp(nextPage, minPage, Math.max(total, 1))
    setPage(pageNo)
    const updated = { ...nextRecord, lastPage: pageNo, updatedAt: Date.now() }
    setRecord(updated)
  }

  function goNext() {
    const last = visiblePages(page, total, settings.spread, wide, hasCover).at(-1) ?? page
    if (last < total) commit(last + 1)
  }

  function goPrev() {
    const first = visiblePages(page, total, settings.spread, wide, hasCover)[0] ?? page
    if (first > (hasCover ? 0 : 1)) commit(first - 1)
  }

  function toggleBookmark() {
    const exists = record.bookmarks.some((item) => item.page === page)
    const bookmarks = exists
      ? record.bookmarks.filter((item) => item.page !== page)
      : [...record.bookmarks, { page, label: page === 0 ? '표지' : `${page}쪽`, createdAt: Date.now() }].sort((a, b) => a.page - b.page)
    const updated = { ...record, bookmarks, updatedAt: Date.now(), lastPage: page }
    setRecord(updated)
    onToast(exists ? '책갈피를 지웠습니다.' : `${page}쪽에 책갈피를 꽂았습니다.`)
  }

  function toggleDrawer(mode: 'toc' | 'marks') {
    setDrawer((current) => current === mode ? null : mode)
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await rootRef.current?.requestFullscreen()
    } catch (err) {
      console.error(err)
      onToast('전체 화면을 사용할 수 없습니다.')
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault()
        goNext()
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        goPrev()
      } else if (event.key === 'Home') {
        event.preventDefault()
        commit(hasCover ? 0 : 1)
      } else if (event.key === 'End') {
        event.preventDefault()
        commit(total)
      } else if (event.key === 'f' || event.key === 'F') void toggleFullscreen()
      else if (event.key === 'b' || event.key === 'B') toggleBookmark()
      else if (event.key === 't' || event.key === 'T') toggleDrawer('toc')
      else if (event.key === '+' || event.key === '=') onSettings({ ...settings, zoom: clamp(Math.round((settings.zoom + 0.1) * 10) / 10, 0.5, 3) })
      else if (event.key === '-' || event.key === '_') onSettings({ ...settings, zoom: clamp(Math.round((settings.zoom - 0.1) * 10) / 10, 0.5, 3) })
      else if (event.key === 'Escape') {
        if (drawer) setDrawer(null)
        else if (helpOpen) setHelpOpen(false)
      } else if (event.key === '?') setHelpOpen((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const themes: ThemeName[] = ['night', 'day', 'sepia']
  const themeLabel: Record<ThemeName, string> = { night: '밤', day: '낮', sepia: '종이' }

  return (
    <section id="reader" ref={rootRef} tabIndex={-1} aria-label="전자책 읽기" data-theme={settings.theme}>
      <div id="read-progress" style={{ width: `${(Math.max(...pages) / Math.max(total, 1)) * 100}%` }} />
      <header className="reader-top">
        <button className="tool" type="button" onClick={onClose}>닫기</button>
        <div className="reader-heading">
          <h2>{record.title}</h2>
          {record.author && <p>{record.author}</p>}
        </div>
        <button
          className="tool"
          type="button"
          aria-pressed={settings.fit === 'width'}
          onClick={() => onSettings({ ...settings, fit: settings.fit === 'page' ? 'width' : 'page' })}
        >
          {settings.fit === 'page' ? '쪽 맞춤' : '너비 맞춤'}
        </button>
        <button
          className="tool"
          type="button"
          aria-pressed={settings.spread}
          title="넓은 화면에서 두 쪽씩 봅니다"
          onClick={() => onSettings({ ...settings, spread: !settings.spread })}
        >
          {settings.spread ? '펼침' : '한 쪽'}
        </button>
        <div className="segmented" role="group" aria-label="읽기 배경">
          {themes.map((name) => (
            <button key={name} type="button" aria-pressed={settings.theme === name} onClick={() => onSettings({ ...settings, theme: name })}>
              {themeLabel[name]}
            </button>
          ))}
        </div>
        <button className="tool" type="button" aria-expanded={drawer === 'toc'} onClick={() => toggleDrawer('toc')}>목차</button>
        <button className="tool" type="button" aria-pressed={marked} aria-expanded={drawer === 'marks'} onClick={() => toggleDrawer('marks')}>책갈피</button>
        <button className="tool" type="button" onClick={() => void toggleFullscreen()}>{full ? '화면 축소' : '전체 화면'}</button>
        <div className="help-wrap" ref={helpRef}>
          <button className="tool icon-btn" type="button" aria-label="단축키" onClick={() => setHelpOpen((open) => !open)}>?</button>
          {helpOpen && (
            <div className="help-pop">
              <p>단축키</p>
              <ul>
                <li><span><kbd>←</kbd> <kbd>→</kbd></span><span>페이지</span></li>
                <li><span><kbd>Home</kbd> <kbd>End</kbd></span><span>처음 / 끝</span></li>
                <li><kbd>B</kbd><span>책갈피</span></li>
                <li><kbd>T</kbd><span>목차</span></li>
                <li><kbd>F</kbd><span>전체 화면</span></li>
                <li><span><kbd>+</kbd> <kbd>−</kbd></span><span>확대 / 축소</span></li>
              </ul>
            </div>
          )}
        </div>
      </header>

      <div className="reader-body">
        {drawer && (
          <aside id="drawer">
            <div className="drawer-head">
              <h2>{drawer === 'toc' ? '목차' : '책갈피'}</h2>
              <button className="tool" type="button" onClick={() => setDrawer(null)}>닫기</button>
            </div>
            {drawer === 'toc' ? (
              outline.length === 0 ? <p className="muted">이 PDF에는 목차가 없습니다.</p> : (
                <ul className="toc">
                  {outline.map((item, index) => (
                    <li key={`${item.title}-${index}`} style={{ paddingLeft: item.depth * 14 }}>
                      <button
                        className="toc-item"
                        type="button"
                        onClick={() => {
                          const pdf = pdfRef.current
                          if (!pdf) return
                          void destToPage(pdf, item.dest).then((target) => {
                            if (!target) {
                              onToast('이 목차 항목은 페이지로 연결되지 않습니다.')
                              return
                            }
                            setDrawer(null)
                            commit(target)
                          })
                        }}
                      >
                        {item.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <>
                <button className="tool" type="button" onClick={toggleBookmark}>
                  {marked ? '이 쪽 책갈피 빼기' : '이 쪽에 책갈피'}
                </button>
                {record.bookmarks.length === 0 ? <p className="muted">아직 책갈피가 없습니다.</p> : (
                  <ul className="toc">
                    {record.bookmarks.map((mark) => (
                      <li className="mark-row" key={mark.page}>
                        <button className="toc-item" type="button" onClick={() => { setDrawer(null); commit(mark.page) }}>
                          {mark.label || `${mark.page}쪽`}
                        </button>
                        <button
                          className="text-btn danger"
                          type="button"
                          onClick={() => {
                            setRecord({
                              ...record,
                              bookmarks: record.bookmarks.filter((item) => item.page !== mark.page),
                              updatedAt: Date.now(),
                            })
                          }}
                        >
                          삭제
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </aside>
        )}

        <div
          id="stage"
          ref={stageRef}
          className={`${atStart ? 'at-start' : ''} ${atEnd ? 'at-end' : ''}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            gesture.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
          }}
          onPointerUp={(event) => {
            const start = gesture.current
            gesture.current = null
            if (!start || start.id !== event.pointerId) return
            const dx = event.clientX - start.x
            const dy = event.clientY - start.y
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
              const rect = stageRef.current?.getBoundingClientRect()
              if (!rect) return
              const x = event.clientX - rect.left
              if (x < rect.width * 0.22) goPrev()
              else if (x > rect.width * 0.78) goNext()
              return
            }
            if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
              if (dx < 0) goNext()
              else goPrev()
            }
          }}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            const next = settings.zoom + (event.deltaY < 0 ? 0.1 : -0.1)
            onSettings({ ...settings, zoom: clamp(Math.round(next * 10) / 10, 0.5, 3) })
          }}
        >
          <p className="sr-only">왼쪽을 누르면 이전 쪽, 오른쪽을 누르면 다음 쪽입니다.</p>
          <div className="turn-hint turn-hint-left" aria-hidden="true">‹</div>
          <div className="stage-scroll">
            <div className="book-slot" ref={slotRef}>
              <div className={`book${pages.length === 2 ? ' spread' : ''}`}>
                <div className="sheet" hidden={pages.length !== 2}>
                  <canvas ref={leftRef} width={0} height={0} aria-hidden="true" />
                </div>
                <div id="spine" hidden={pages.length !== 2} />
                <div className="sheet">
                  <canvas ref={rightRef} width={0} height={0} aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>
          <div className="turn-hint turn-hint-right" aria-hidden="true">›</div>
          {painting && <p className="paint-status">페이지를 그리는 중</p>}
        </div>
      </div>

      <footer className="reader-bottom">
        <button className="tool" type="button" onClick={goPrev} disabled={atStart}>이전</button>
        <input
          id="page-slider"
          type="range"
          min={hasCover ? 0 : 1}
          max={Math.max(total, 1)}
          value={clamp(page, hasCover ? 0 : 1, Math.max(total, 1))}
          step={1}
          aria-label="페이지"
          onChange={(event) => commit(Number(event.target.value))}
        />
        <button className="tool" type="button" onClick={goNext} disabled={atEnd}>다음</button>
        <span id="page-label" className="nums" aria-live="polite">{rangeLabel} / {total}</span>
        <button className="tool icon-btn" type="button" aria-label="축소" onClick={() => onSettings({ ...settings, zoom: clamp(Math.round((settings.zoom - 0.1) * 10) / 10, 0.5, 3) })}>−</button>
        <span id="zoom-label" className="nums">{Math.round(settings.zoom * 100)}%</span>
        <button className="tool icon-btn" type="button" aria-label="확대" onClick={() => onSettings({ ...settings, zoom: clamp(Math.round((settings.zoom + 0.1) * 10) / 10, 0.5, 3) })}>+</button>
      </footer>
    </section>
  )
}
