// Fallback for connecting a DF folder when `window.showDirectoryPicker` is
// unavailable -- Firefox, Safari, or the app opened as a file:// document.
// Builds a FileSystemDirectoryHandle-shaped object from
// a `<input type="file" webkitdirectory>` selection, in memory only for this
// session: the File blobs it wraps can't be reopened after a reload the way
// a real handle can, so callers should not persist it to IndexedDB.
type DirNode = { kind: 'directory'; name: string; children: Map<string, DirNode | FileNode> };
type FileNode = { kind: 'file'; name: string; file: File };

function buildTree(files: FileList): DirNode {
  const root: DirNode = { kind: 'directory', name: '', children: new Map() };
  for (const file of Array.from(files)) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const existing = dir.children.get(part);
      const next: DirNode = existing && existing.kind === 'directory' ? existing : { kind: 'directory', name: part, children: new Map() };
      dir.children.set(part, next);
      dir = next;
    }
    dir.children.set(parts[parts.length - 1], { kind: 'file', name: parts[parts.length - 1], file });
  }
  return root;
}

function wrapFile(node: FileNode): FileSystemFileHandle {
  return { kind: 'file', name: node.name, getFile: async () => node.file } as unknown as FileSystemFileHandle;
}

function wrapDir(node: DirNode): FileSystemDirectoryHandle {
  const handle = {
    kind: 'directory',
    name: node.name,
    queryPermission: async () => 'granted' as const,
    requestPermission: async () => 'granted' as const,
    getDirectoryHandle: async (name: string) => {
      const child = node.children.get(name);
      if (!child || child.kind !== 'directory') throw new DOMException(`"${name}" not found`, 'NotFoundError');
      return wrapDir(child);
    },
    getFileHandle: async (name: string) => {
      const child = node.children.get(name);
      if (!child || child.kind !== 'file') throw new DOMException(`"${name}" not found`, 'NotFoundError');
      return wrapFile(child);
    },
    entries: async function* () {
      for (const [name, child] of node.children) yield [name, child.kind === 'directory' ? wrapDir(child) : wrapFile(child)] as const;
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

export function folderPickerAvailable(): boolean {
  return 'showDirectoryPicker' in window;
}

export function pickDfFolderViaInput(): Promise<FileSystemDirectoryHandle> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      input.remove();
      const files = input.files;
      const top = files && files.length > 0 ? buildTree(files).children.values().next().value : undefined;
      if (!top || top.kind !== 'directory') { reject(new Error('No folder selected.')); return; }
      resolve(wrapDir(top));
    });
    document.body.appendChild(input);
    input.click();
  });
}
