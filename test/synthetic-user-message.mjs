import { register } from 'node:module'

// These tests exercise synthetic turns without requiring the optional DSH peer.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-llm') return { url: 'data:text/javascript,export const createUserMessage = (value) => ({ ...value, id: crypto.randomUUID() })', shortCircuit: true }
  return nextResolve(specifier, context)
}`)}`, import.meta.url)
