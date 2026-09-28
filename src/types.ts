export type Bookmark = {
  page: number
  label: string
  createdAt: number
}

export type BookRecord = {
  id: string
  fileName: string
  title: string
  author: string
  byteSize: number
  addedAt: number
  updatedAt: number
  lastPage: number
  totalPages: number
  coverUrl: string
  customCover?: boolean
  bookmarks: Bookmark[]
}

export type FitMode = 'page' | 'width'
export type ThemeName = 'night' | 'day' | 'sepia'

export type ReaderSettings = {
  spread: boolean
  fit: FitMode
  zoom: number
  theme: ThemeName
}

export type OutlineEntry = {
  title: string
  dest: unknown
  depth: number
}
