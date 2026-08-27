export interface ProjectFile {
  path: string
  name?: string
  kind?: 'file' | 'directory'
}

export type ProjectFileResolver = (
  query: string,
  projectRoot: string,
) => ProjectFile[] | Promise<ProjectFile[]>

export interface ComposerAttachment {
  id: string
  file: File
  previewUrl?: string
}

export interface AgentComposerSubmitPayload {
  message: string
  projectRoot: string
  attachments: ComposerAttachment[]
  mentionedFiles: ProjectFile[]
}

export type AgentContentPart =
  | {
      type: 'project_directory'
      path: string
    }
  | {
      type: 'file_reference'
      path: string
      name: string
      kind: 'file' | 'directory'
    }
  | {
      type: 'input_file'
      id: string
      name: string
      mediaType: string
      size: number
      file: File
    }
  | {
      type: 'input_text'
      text: string
    }

export interface AgentInputPayload {
  role: 'user'
  content: AgentContentPart[]
}
