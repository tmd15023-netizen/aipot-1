import { useRef, useState } from 'react'
import type { BookRecord } from './types.ts'
import { formatBytes } from './pdf.ts'

type LibraryProps = {
  books: BookRecord[]
  busy: boolean
  status: string
  onUpload: (files: File[]) => void
  onOpen: (id: string, page?: number) => void
  onDelete: (id: string) => void
  onCover: (id: string, file: File) => void
}

export default function Library({ books, busy, status, onUpload, onOpen, onDelete, onCover }: LibraryProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  const book = books[0]

  function pick() {
    inputRef.current?.click()
  }

  function askDelete() {
    setPendingDelete(true)
    dialogRef.current?.showModal()
  }

  function closeDelete() {
    setPendingDelete(false)
    if (dialogRef.current?.open) dialogRef.current.close()
  }

  const progress = book && book.totalPages > 0
    ? Math.min(100, Math.round((Math.max(book.lastPage, 0) / book.totalPages) * 100))
    : 0
  const started = book ? (book.customCover ? book.lastPage > 0 : book.lastPage > 1) : false

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
            <path fill="none" stroke="currentColor" strokeWidth="1.6" d="M4 7.5 16 5l12 2.5V26L16 28 4 26V7.5Z" />
            <path stroke="currentColor" strokeWidth="1.6" d="M16 5v23" />
          </svg>
          <div>
            <p className="eyebrow">한 권을 전자책처럼</p>
            <h1>{book?.title || '전자책'}</h1>
          </div>
        </div>
        <div className="top-actions">
          <button className="primary" type="button" onClick={pick} disabled={busy}>
            {book ? '다른 PDF로 바꾸기' : 'PDF 올리기'}
          </button>
        </div>
      </header>

      <p className="lede">
        {book
          ? '이 화면의 책 한 권만 읽습니다. 다른 PDF를 올리면 이 책이 그 파일로 바뀝니다.'
          : 'PDF 한 권을 올리면 이 화면에서 전자책처럼 읽을 수 있습니다. 파일은 서버로 보내지 않고 이 브라우저에만 남습니다.'}
      </p>

      <div className="status-row">
        <p className="muted">{book ? `${book.totalPages || '?'}쪽` : ''}</p>
        <p className="status" role="status">{status}</p>
      </div>

      {!book ? (
        <section className="empty">
          <div className="empty-art" aria-hidden="true">
            <svg viewBox="0 0 88 88">
              <path fill="none" stroke="currentColor" strokeWidth="2.2" d="M10 20 44 14l34 6v48L44 76 10 68V20Z" />
              <path stroke="currentColor" strokeWidth="2.2" d="M44 14v62" />
              <path fill="none" stroke="currentColor" strokeWidth="1.6" d="M22 32h14M22 42h14M52 32h14M52 42h10" />
            </svg>
          </div>
          <h2>읽을 책을 올려 주세요</h2>
          <p>PDF를 올리거나 이 창에 끌어다 놓으면 바로 읽을 수 있습니다. 표지 이미지를 같이 놓으면 맨 앞에 붙습니다.</p>
          <button className="primary" type="button" onClick={pick} disabled={busy}>PDF 올리기</button>
        </section>
      ) : (
        <section className="single-stage">
          <article className="single-book">
            <button className="cover-btn" type="button" aria-label={`${book.title} 열기`} onClick={() => onOpen(book.id)}>
              {book.coverUrl ? (
                <img src={book.coverUrl} alt="" />
              ) : (
                <span className="cover-fallback">{(book.title || '?').slice(0, 1)}</span>
              )}
              {started && (
                <span className="cover-progress">
                  <span style={{ width: `${progress}%` }} />
                </span>
              )}
            </button>
            <h2>{book.title}</h2>
            {book.author && <p className="author">{book.author}</p>}
            <p className="meta">
              {started ? `${book.lastPage === 0 ? '표지' : `${book.lastPage}쪽`}까지 읽음 · ` : ''}
              {book.totalPages || '?'}쪽 · {formatBytes(book.byteSize || 0)}
            </p>
            <div className="card-actions single-actions">
              <button className="primary" type="button" onClick={() => onOpen(book.id)}>
                {started ? '이어 읽기' : '읽기'}
              </button>
              {started && (
                <button className="text-btn" type="button" onClick={() => onOpen(book.id, book.customCover ? 0 : 1)}>처음부터</button>
              )}
              <button className="text-btn" type="button" onClick={() => coverInputRef.current?.click()}>
                {book.customCover ? '표지 변경' : '표지'}
              </button>
              <button className="text-btn danger" type="button" onClick={askDelete}>삭제</button>
            </div>
          </article>
        </section>
      )}

      <footer className="foot">
        <p>표지 이미지는 표지 버튼으로 넣거나, PDF와 함께 끌어다 놓으면 맨 앞에 붙습니다.</p>
        <p>읽던 쪽과 책갈피는 이 브라우저 안에만 저장됩니다.</p>
      </footer>

      <input
        ref={coverInputRef}
        className="file-input"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file && book) onCover(book.id, file)
        }}
      />

      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept=".pdf,application/pdf,image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length) onUpload(files)
        }}
      />

      <dialog ref={dialogRef} onClose={closeDelete}>
        <div className="dialog-card">
          <h2>이 책을 지울까요?</h2>
          <p>「{book?.title}」은 이 브라우저에서만 삭제됩니다. 컴퓨터에 있는 원본 파일은 그대로입니다.</p>
          <div className="dialog-actions">
            <button className="ghost" type="button" onClick={closeDelete}>취소</button>
            <button
              className="danger"
              type="button"
              onClick={() => {
                if (pendingDelete && book) onDelete(book.id)
                closeDelete()
              }}
            >
              삭제
            </button>
          </div>
        </div>
      </dialog>
    </div>
  )
}
