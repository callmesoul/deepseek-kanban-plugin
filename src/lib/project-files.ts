import type { ProjectFile } from '@/components/agent-composer';

export function projectFilesFromPaths(paths: string[]): ProjectFile[] {
  const directories = new Set<string>();

  for (const path of paths) {
    let separator = path.lastIndexOf('/');
    while (separator > 0) {
      directories.add(path.slice(0, separator));
      separator = path.lastIndexOf('/', separator - 1);
    }
  }

  return paths.map((path) => ({
    path,
    name: path.split('/').at(-1) ?? path,
    kind: directories.has(path) ? 'directory' : 'file',
  }));
}
