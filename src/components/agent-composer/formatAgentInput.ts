import type { AgentComposerSubmitPayload, AgentInputPayload } from './types'

function getFileName(path: string) {
  return path.split(/[\\/]/).at(-1) ?? path
}

function attachmentPath(file: File) {
  const nativePath = (file as File & { path?: string }).path
  return nativePath?.trim() || file.webkitRelativePath || file.name
}

function formatFileReference(file: File) {
  const path = attachmentPath(file)
  const label = getFileName(path).replace(/[[\]]/g, '')
  const safePath = path.replace(/>/g, '').trim()
  const title = safePath.replace(/"/g, '').replace(/\s+/g, ' ')
  return `[${label}](<file://${safePath}> "${title}")`
}

export function formatAgentInput(payload: AgentComposerSubmitPayload): AgentInputPayload {
  const content: AgentInputPayload['content'] = []

  if (payload.projectRoot.trim()) {
    content.push({
      type: 'project_directory',
      path: payload.projectRoot.trim(),
    })
  }

  content.push(
    ...payload.mentionedFiles.map((file) => ({
      type: 'file_reference' as const,
      path: file.path,
      name: file.name ?? getFileName(file.path),
      kind: file.kind ?? ('file' as const),
    })),
  )

  content.push(
    ...payload.attachments.map((attachment) => ({
      type: 'input_file' as const,
      id: attachment.id,
      name: attachment.file.name,
      mediaType: attachment.file.type || 'application/octet-stream',
      size: attachment.file.size,
      file: attachment.file,
    })),
  )

  if (payload.message.trim()) {
    content.push({
      type: 'input_text',
      text: payload.message.trim(),
    })
  }

  return {
    role: 'user',
    content,
  }
}

export function formatComposerText(payload: AgentComposerSubmitPayload) {
  return [payload.message.trim(), ...payload.attachments.map(({ file }) => formatFileReference(file))]
    .filter(Boolean)
    .join('\n')
}
