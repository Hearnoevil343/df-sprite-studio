// TS's bundled DOM lib has FileSystemDirectoryHandle/FileSystemFileHandle
// (structure and iteration) but not the permission methods or the picker
// entry point yet. Declared by hand instead of adding a types package for
// three small members.
type FsPermissionDescriptor = { mode?: 'read' | 'readwrite' };
type FsPermissionState = 'granted' | 'denied' | 'prompt';

interface FileSystemHandle {
  queryPermission(descriptor?: FsPermissionDescriptor): Promise<FsPermissionState>;
  requestPermission(descriptor?: FsPermissionDescriptor): Promise<FsPermissionState>;
}

interface Window {
  showDirectoryPicker(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}
