import { useCallback, useEffect, useRef, useState } from 'react'
import Library from './Library.tsx'
import Reader from './Reader.tsx'
import {
  friendlyOpenError,
  isCancelled,
  isPdf,
  isQuota,
  makeCover,
  openPdf,
  rememberPassword,
  setPasswordAsker,
  titleFromName,
  usableTitle,
  cleanText,
  imageFileToCover,
  isImage,
} from './pdf.ts'
import { allBooks, getFile, putBook, removeBook, sortBooks, storageIsMemory, updateBook } from './storage.ts'
import type { BookRecord, ReaderSettings } from './types.ts'

const SETTINGS_KEY = 'seojae-settings'

function loadSettings(): ReaderSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<ReaderSettings>
    return {
      spread: saved.spread !== false,
      fit: saved.fit === 'width' ? 'width' : 'page',
      zoom: Math.min(3, Math.max(0.5, Number(saved.zoom) || 1)),
      theme: saved.theme === 'day' || saved.theme === 'sepia' ? saved.theme : 'night',
    }
  } catch {
    return { spread: true, fit: 'page', zoom: 1, theme: 'night' }
  }
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export default function App() {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings)
  const [reading, setReading] = useState<BookRecord | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [passwordCopy, setPasswordCopy] = useState('이 PDF는 비밀번호로 보호되어 있습니다.')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const booksRef = useRef<BookRecord[]>([])
  const importing = useRef(false)
  const queue = useRef<Array<{ file: File; cover?: File }>>([])
  const passwordRef = useRef<HTMLDialogElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const finishPassword = useRef<((value: string | null) => void) | null>(null)
  const dragTimer = useRef(0)

  booksRef.current = books

  const onToast = useCallback((message: string) => setToast(message), [])
  const onChange = useCallback((next: BookRecord) => {
    setBooks((current) => sortBooks(current.map((item) => item.id === next.id ? next : item)))
    void updateBook(next)
  }, [])
  const closeBook = useCallback(() => {
    setReading(null)
    setBlob(null)
  }, [])

  useEffect(() => {
    setPasswordAsker((wrong) => new Promise((resolve) => {
      finishPassword.current = (value) => {
        finishPassword.current = null
        setPasswordOpen(false)
        if (passwordRef.current?.open) passwordRef.current.close()
        resolve(value)
      }
      setPasswordCopy(wrong
        ? '비밀번호가 올바르지 않습니다. 다시 입력해 주세요.'
        : '이 PDF는 비밀번호로 보호되어 있습니다.')
      setPasswordOpen(true)
    }))
  }, [])

  useEffect(() => {
    if (!passwordOpen) return
    const dialog = passwordRef.current
    if (passwordInput.current) passwordInput.current.value = ''
    if (dialog && !dialog.open) dialog.showModal()
    passwordInput.current?.focus()
  }, [passwordOpen])

  useEffect(() => {
    let alive = true
    void allBooks().then(async (rows) => {
      if (!alive) return
      const sorted = sortBooks(rows)
      const keep = sorted[0]
      if (sorted.length > 1) {
        await Promise.all(sorted.slice(1).map((item) => removeBook(item.id)))
      }
      if (!alive) return
      setBooks(keep ? [keep] : [])
      if (storageIsMemory()) onToast('이 브라우저에 저장할 수 없어, 탭을 닫으면 책이 사라집니다.')
    }).catch((err) => {
      console.error(err)
      onToast('책을 불러오지 못했습니다.')
    })
    return () => { alive = false }
  }, [onToast])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    document.body.classList.toggle('reading', Boolean(reading))
    document.body.classList.toggle('is-busy', busy)
    if (!reading) document.title = '전자책'
  }, [reading, busy])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files')
    const onEnter = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragging(true)
      window.clearTimeout(dragTimer.current)
      dragTimer.current = window.setTimeout(() => setDragging(false), 180)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      window.clearTimeout(dragTimer.current)
      setDragging(false)
      void addFiles([...(event.dataTransfer?.files ?? [])])
    }
    document.addEventListener('dragenter', onEnter)
    document.addEventListener('dragover', onOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onEnter)
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', onDrop)
    }
  })

  async function importOne(file: File, coverFile?: File) {
    if (!file.size) {
      onToast(`빈 파일입니다: ${file.name}`)
      return
    }
    if (booksRef.current.some((item) => item.fileName === file.name && item.byteSize === file.size)) {
      onToast(`이미 이 책이 열려 있습니다: ${file.name}`)
      return
    }
    if (file.size > 150 * 1024 * 1024) onToast('큰 PDF입니다. 여는 데 시간이 걸릴 수 있습니다.')
    try {
      const data = await file.arrayBuffer()
      const opened = await openPdf(data, null)
      try {
        const meta = await opened.pdf.getMetadata()
        const info = (meta.info ?? {}) as { Title?: string; Author?: string }
        let coverUrl = ''
        let customCover = false
        if (coverFile) {
          try {
            coverUrl = await imageFileToCover(coverFile)
            customCover = true
          } catch (err) {
            console.error(err)
          }
        }
        if (!coverUrl) {
          try { coverUrl = await makeCover(opened.pdf) } catch (err) { console.error(err) }
        }
        const record: BookRecord = {
          id: newId(),
          fileName: file.name,
          title: usableTitle(info.Title, titleFromName(file.name)),
          author: cleanText(info.Author),
          byteSize: file.size,
          addedAt: Date.now(),
          updatedAt: Date.now(),
          lastPage: customCover ? 0 : 1,
          totalPages: opened.pdf.numPages,
          coverUrl,
          customCover,
          bookmarks: [],
        }
        await putBook(record, file)
        if (opened.password) rememberPassword(record.id, opened.password)
        await Promise.all(booksRef.current.map((item) => removeBook(item.id)))
        booksRef.current = [record]
        setBooks([record])
      } finally {
        opened.pdf.destroy()
      }
    } catch (err) {
      if (isCancelled(err)) {
        onToast('비밀번호 입력을 취소해 이 책은 담지 않았습니다.')
        return
      }
      console.error(err)
      if (isQuota(err)) {
        onToast('브라우저 저장 공간이 부족합니다. 책을 지운 뒤 다시 올려 주세요.')
        return
      }
      onToast(friendlyOpenError(err) === '이 PDF를 열 수 없습니다.'
        ? `열 수 없습니다: ${file.name}`
        : friendlyOpenError(err))
    }
  }

  async function setCover(id: string, file: File) {
    const book = booksRef.current.find((item) => item.id === id)
    if (!book) return
    try {
      const coverUrl = await imageFileToCover(file)
      const next: BookRecord = {
        ...book,
        coverUrl,
        customCover: true,
        updatedAt: Date.now(),
        lastPage: book.lastPage <= 1 ? 0 : book.lastPage,
      }
      await updateBook(next)
      const nextBooks = sortBooks(booksRef.current.map((item) => item.id === id ? next : item))
      booksRef.current = nextBooks
      setBooks(nextBooks)
      onToast('표지를 책 맨 앞에 넣었습니다. 처음부터 열면 표지부터 보입니다.')
    } catch (err) {
      console.error(err)
      onToast('이 이미지는 표지로 쓸 수 없습니다.')
    }
  }

  async function addFiles(files: File[]) {
    const pdfs = files.filter(isPdf)
    const images = files.filter(isImage)
    const skipped = files.length - pdfs.length - images.length
    if (skipped) onToast('PDF와 이미지 외의 파일은 제외했습니다.')
    if (!pdfs.length && images.length) {
      if (booksRef.current[0]) {
        await setCover(booksRef.current[0].id, images[0]!)
        return
      }
      onToast('표지 이미지는 PDF와 함께 올리거나, 책을 담은 뒤 표지 버튼으로 넣어 주세요.')
      return
    }
    if (!pdfs.length) {
      if (files.length) onToast('PDF 파일만 책으로 올릴 수 있습니다.')
      return
    }
    if (pdfs.length > 1) onToast('책은 한 권만 담을 수 있어, 첫 PDF만 올렸습니다.')
    queue.current = [{ file: pdfs[0]!, cover: images[0] }]
    if (importing.current) return
    importing.current = true
    setBusy(true)
    try {
      while (queue.current.length) {
        const item = queue.current.shift()
        if (!item) break
        setStatus(`「${item.file.name}」 담는 중…`)
        await importOne(item.file, item.cover)
      }
    } finally {
      importing.current = false
      setBusy(false)
      setStatus('')
    }
  }

  async function openBook(id: string, page?: number) {
    const book = booksRef.current.find((item) => item.id === id)
    if (!book) return
    setBusy(true)
    setStatus('책을 열고 있습니다…')
    try {
      const file = await getFile(id)
      if (!file) {
        onToast('저장된 PDF를 찾을 수 없습니다.')
        return
      }
      setBlob(file)
      setReading(page !== undefined ? { ...book, lastPage: page } : book)
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  async function deleteBook(id: string) {
    try {
      await removeBook(id)
      setBooks((current) => current.filter((item) => item.id !== id))
      if (reading?.id === id) closeBook()
      onToast('이 브라우저에서 책을 지웠습니다.')
    } catch (err) {
      console.error(err)
      onToast('책을 지우지 못했습니다.')
    }
  }

  function settlePassword(value: string | null) {
    finishPassword.current?.(value)
  }

  return (
    <>
      <Library
        books={books}
        busy={busy}
        status={status}
        onUpload={(files) => void addFiles(files)}
        onOpen={(id, page) => void openBook(id, page)}
        onDelete={(id) => void deleteBook(id)}
        onCover={(id, file) => void setCover(id, file)}
      />
      {reading && blob && (
        <Reader
          key={reading.id}
          book={reading}
          blob={blob}
          settings={settings}
          onSettings={setSettings}
          onClose={closeBook}
          onChange={onChange}
          onToast={onToast}
        />
      )}
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <strong>PDF를 놓으면 이 책으로 담깁니다</strong>
            <span>파일은 이 브라우저에만 저장됩니다</span>
          </div>
        </div>
      )}
      <dialog
        ref={passwordRef}
        onClose={() => {
          if (finishPassword.current) settlePassword(null)
        }}
      >
        <form
          className="dialog-card"
          onSubmit={(event) => {
            event.preventDefault()
            const value = passwordInput.current?.value ?? ''
            if (!value) {
              setPasswordCopy('비밀번호를 입력해 주세요.')
              return
            }
            settlePassword(value)
          }}
        >
          <h2>비밀번호</h2>
          <p>{passwordCopy}</p>
          <input ref={passwordInput} type="password" autoComplete="off" spellCheck={false} aria-label="PDF 비밀번호" />
          <div className="dialog-actions">
            <button className="ghost" type="button" onClick={() => settlePassword(null)}>취소</button>
            <button className="primary" type="submit">열기</button>
          </div>
        </form>
      </dialog>
      <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">{toast}</div>
    </>
  )
}
