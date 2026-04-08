import { useMemo, useCallback } from 'react'
import { marked, type Tokens } from 'marked'
import { CodeViewer } from '../chat/CodeViewer'

type Props = {
  content: string
}

type CodeBlock = {
  id: string
  code: string
  language: string | undefined
}

const renderer = new marked.Renderer()

let pendingCodeBlocks: CodeBlock[] = []

renderer.code = function ({ text, lang }: Tokens.Code) {
  const id = `cb-${pendingCodeBlocks.length}`
  pendingCodeBlocks.push({ id, code: text, language: lang || undefined })
  return `<div data-codeblock-id="${id}"></div>`
}

marked.setOptions({
  breaks: true,
  gfm: true,
})
marked.use({ renderer })

function parseMarkdown(content: string): { html: string; codeBlocks: CodeBlock[] } {
  pendingCodeBlocks = []
  const html = marked.parse(content) as string
  const codeBlocks = [...pendingCodeBlocks]
  pendingCodeBlocks = []
  return { html, codeBlocks }
}

export function MarkdownRenderer({ content }: Props) {
  const { html, codeBlocks } = useMemo(() => parseMarkdown(content), [content])

  const parts = useMemo(() => {
    if (codeBlocks.length === 0) {
      return [{ type: 'html' as const, content: html }]
    }

    const result: Array<{ type: 'html'; content: string } | { type: 'code'; block: CodeBlock }> = []
    let remaining = html

    for (const block of codeBlocks) {
      const marker = `<div data-codeblock-id="${block.id}"></div>`
      const idx = remaining.indexOf(marker)
      if (idx === -1) continue

      const before = remaining.slice(0, idx)
      if (before) {
        result.push({ type: 'html', content: before })
      }
      result.push({ type: 'code', block })
      remaining = remaining.slice(idx + marker.length)
    }

    if (remaining) {
      result.push({ type: 'html', content: remaining })
    }

    return result
  }, [html, codeBlocks])

  const handleClick = useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    const button = target?.closest<HTMLButtonElement>('[data-copy-code]')
    if (!button) return

    const text = button.getAttribute('data-copy-code')
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      const original = button.textContent
      button.textContent = 'Copied'
      window.setTimeout(() => {
        button.textContent = original
      }, 1500)
    } catch {
      // Ignore clipboard errors
    }
  }, [])

  const proseClasses = `prose prose-sm max-w-none text-[var(--color-text-primary)]
    prose-headings:text-[var(--color-text-primary)] prose-headings:font-semibold
    prose-p:my-2 prose-p:leading-relaxed
    prose-p:break-words
    prose-code:text-[13px] prose-code:font-[var(--font-mono)] prose-code:bg-[var(--color-surface-info)] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
    prose-pre:!bg-transparent prose-pre:!p-0 prose-pre:!shadow-none
    prose-a:text-[var(--color-text-accent)] prose-a:no-underline hover:prose-a:underline
    prose-strong:text-[var(--color-text-primary)]
    prose-ul:my-2 prose-ol:my-2
    prose-li:my-0.5
    prose-table:w-full prose-table:table-auto prose-table:text-sm
    prose-th:bg-[var(--color-surface-info)] prose-th:px-3 prose-th:py-2 prose-th:whitespace-normal prose-th:break-words prose-th:align-top
    prose-td:px-3 prose-td:py-2 prose-td:border-[var(--color-border)] prose-td:whitespace-normal prose-td:break-words prose-td:align-top`

  if (codeBlocks.length === 0) {
    return (
      <div
        className={proseClasses}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
      />
    )
  }

  return (
    <div className={proseClasses} onClick={handleClick}>
      {parts.map((part, i) =>
        part.type === 'html' ? (
          <div key={i} dangerouslySetInnerHTML={{ __html: part.content }} />
        ) : (
          <div key={part.block.id} className="my-4">
            <CodeViewer
              code={part.block.code}
              language={part.block.language}
            />
          </div>
        )
      )}
    </div>
  )
}
