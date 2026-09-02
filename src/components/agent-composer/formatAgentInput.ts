import type {
  AgentComposerSubmitPayload,
  AgentInputPayload,
  UploadedAttachment,
} from './types'

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const MAX_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024

function getFileName(path: string) {
  return path.split(/[\\/]/).at(-1) ?? path
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
  return payload.message.trim()
}

export async function uploadComposerAttachments(
  payload: AgentComposerSubmitPayload,
): Promise<UploadedAttachment[]> {
  const files = payload.attachments.map(({ file }) => file)
  const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES)
  if (oversized) throw new Error(`附件“${oversized.name}”超过 50 MiB`)
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 100 MiB')

  return Promise.all(files.map(async (file) => {
    const response = await fetch('/kanban/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Kanban-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(result?.error || `附件“${file.name}”上传失败`)
    }
    return result as UploadedAttachment
  }))
}
