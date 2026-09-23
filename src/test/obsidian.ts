// A minimal stand-in for the parts of the `obsidian` runtime the vault executors touch, aliased over the real module in vite.config.ts for `vp test` only.
//
// It exists because the published `obsidian` package ships TYPES ONLY — there is no runtime module behind the import, so anything that uses `TFile`/`TFolder` as values (the executors' instanceof guards, which are load-bearing safety code) could not be imported under Vitest at all. Everything here is therefore deliberately dumb: real classes so `instanceof` behaves, and an in-memory vault the tests drive directly. The plugin bundle marks `obsidian` external, so none of this can reach a released build.

export class TAbstractFile {
  path = ''
  name = ''
  parent: TFolder | null = null
}

export class TFile extends TAbstractFile {
  extension = ''
  stat = { ctime: 0, mtime: 0, size: 0 }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = []
  isRoot(): boolean {
    return this.path === ''
  }
}

/** An in-memory vault: a flat path→content map, with folders synthesised from the paths. Enough for the read/list/search/write executors; it is not an Obsidian emulator. */
export class FakeVault {
  readonly files = new Map<string, string>()
  /** Called before every cachedRead, so a test can abort a long scan mid-flight. */
  onRead: ((path: string) => void) | null = null
  readonly trashed: string[] = []

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content)
  }

  private fileFor(path: string): TFile {
    const file = new TFile()
    file.path = path
    file.name = path.slice(path.lastIndexOf('/') + 1)
    file.extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1) : ''
    file.stat = { ctime: 0, mtime: 0, size: (this.files.get(path) ?? '').length }
    return file
  }

  getRoot(): TFolder {
    return this.folderFor('')
  }

  private folderFor(path: string): TFolder {
    const folder = new TFolder()
    folder.path = path
    folder.name = path.slice(path.lastIndexOf('/') + 1)
    const prefix = path === '' ? '' : `${path}/`
    const seen = new Set<string>()
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const rest = filePath.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        folder.children.push(this.fileFor(filePath))
      } else if (!seen.has(rest.slice(0, slash))) {
        seen.add(rest.slice(0, slash))
        folder.children.push(this.folderFor(`${prefix}${rest.slice(0, slash)}`))
      }
    }
    return folder
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (this.files.has(path)) return this.fileFor(path)
    const prefix = `${path}/`
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) return this.folderFor(path)
    }
    return null
  }

  getFiles(): TFile[] {
    return [...this.files.keys()].map((path) => this.fileFor(path))
  }

  async cachedRead(file: TFile): Promise<string> {
    this.onRead?.(file.path)
    return this.files.get(file.path) ?? ''
  }

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? ''
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.files.set(file.path, data)
  }

  async create(path: string, data: string): Promise<TFile> {
    this.files.set(path, data)
    return this.fileFor(path)
  }

  async createFolder(_path: string): Promise<TFolder> {
    return this.folderFor(_path)
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    this.trashed.push(file.path)
    this.files.delete(file.path)
  }

  async delete(file: TAbstractFile): Promise<void> {
    this.files.delete(file.path)
  }
}

export class App {
  readonly fileManager: { trashFile?: (file: TAbstractFile) => Promise<void> } = {}
  constructor(readonly vault: FakeVault = new FakeVault()) {}
}

export type Vault = FakeVault

export class Modal {
  constructor(readonly app: App) {}
  open(): void {}
  close(): void {}
}

export class Notice {
  constructor(readonly message: string) {}
}

export const Platform = { isMobile: false }

/** Enough of the settings-tab surface for `src/settings.ts` to be IMPORTED (tests only read DEFAULT_SETTINGS from it); none of these render anything. */
export class PluginSettingTab {
  constructor(
    readonly app: App,
    readonly plugin: unknown
  ) {}
  display(): void {}
}

export class Setting {
  constructor(readonly containerEl: unknown) {}
  setName(): this {
    return this
  }
  setDesc(): this {
    return this
  }
  addText(): this {
    return this
  }
  addDropdown(): this {
    return this
  }
  addButton(): this {
    return this
  }
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn
}
