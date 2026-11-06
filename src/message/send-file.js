import { resolveOutboundMedia } from '../media/outbound.js'

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')
}

/**
 * @param {{ conversationId?: string, mediaDirs?: string[], allowedDirs?: string[], cwd?: string, stateDir?: string, maxBytes?: number,
 *   contextToken?: string, warn?: (line: string) => void,
 *   sendMedia: (params: { filePath: string, conversationId?: string, contextToken?: string }) => Promise<void> }} options
 * @returns {{ send: (arg?: string) => Promise<string> }}
 */
export function createSendCommands({ conversationId, mediaDirs, allowedDirs = mediaDirs, cwd, stateDir, maxBytes, contextToken, warn, sendMedia } = {}) {
  return {
    async send(arg = '') {
      const raw = String(arg ?? '').trim()
      if (raw === '') {
        return '/send <文件路径> 把电脑上的文件发到当前微信聊天'
      }
      const resolved = await resolveOutboundMedia({ filePath: raw, allowedDirs, cwd, stateDir, maxBytes })
      if (!resolved.ok) return `发不了：${resolved.status}`
      try {
        await sendMedia({ filePath: resolved.path, conversationId, contextToken, allowedDirs, maxBytes })
      } catch (error) {
        warn?.(`send command failed for ${resolved.path}: ${String(error)}`)
        return '发送失败，稍后再试；文件没有被删除。'
      }
      return `已发送：${resolved.name}（${megabytes(resolved.size)} MB）`
    },
  }
}
