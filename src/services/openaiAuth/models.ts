export const OPENAI_DEFAULT_MAIN_MODEL = 'gpt-5.3-codex'
export const OPENAI_DEFAULT_SONNET_MODEL = 'gpt-5.4'
export const OPENAI_DEFAULT_HAIKU_MODEL = 'gpt-5.4-mini'

export type OpenAIModelCatalogEntry = {
  value: string
  label: string
  description: string
  descriptionForModel?: string
}

export const OPENAI_CODEX_MODEL_CATALOG: OpenAIModelCatalogEntry[] = [
  {
    value: OPENAI_DEFAULT_MAIN_MODEL,
    label: 'GPT-5.3 Codex',
    description: 'Best for coding and agentic work',
    descriptionForModel: 'GPT-5.3 Codex - best for coding and agentic work',
  },
  {
    value: OPENAI_DEFAULT_SONNET_MODEL,
    label: 'GPT-5.4',
    description: 'Strong general-purpose model',
    descriptionForModel: 'GPT-5.4 - strong general-purpose model',
  },
  {
    value: OPENAI_DEFAULT_HAIKU_MODEL,
    label: 'GPT-5.4 Mini',
    description: 'Fastest for quick tasks',
    descriptionForModel: 'GPT-5.4 Mini - fastest for quick tasks',
  },
]

export function isOpenAIResponsesModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized.startsWith('gpt-') || /^o\d/.test(normalized)
}

export function resolveOpenAICodexModel(model: string): string {
  if (process.env.OPENAI_CODEX_MODEL?.trim()) {
    return process.env.OPENAI_CODEX_MODEL.trim()
  }

  const normalized = model.trim().toLowerCase()
  if (isOpenAIResponsesModel(normalized)) {
    return model
  }

  if (normalized.includes('haiku')) {
    return (
      process.env.OPENAI_CODEX_HAIKU_MODEL?.trim() ||
      OPENAI_DEFAULT_HAIKU_MODEL
    )
  }

  if (normalized.includes('sonnet')) {
    return (
      process.env.OPENAI_CODEX_SONNET_MODEL?.trim() ||
      OPENAI_DEFAULT_SONNET_MODEL
    )
  }

  if (normalized.includes('opus')) {
    return (
      process.env.OPENAI_CODEX_OPUS_MODEL?.trim() || OPENAI_DEFAULT_MAIN_MODEL
    )
  }

  return OPENAI_DEFAULT_MAIN_MODEL
}

export function getOpenAIModelDisplayName(model: string): string | null {
  switch (model.trim().toLowerCase()) {
    case 'gpt-5.3-codex':
      return 'GPT-5.3 Codex'
    case 'gpt-5.4':
      return 'GPT-5.4'
    case 'gpt-5.4-mini':
      return 'GPT-5.4 Mini'
    case 'gpt-5.2':
      return 'GPT-5.2'
    case 'gpt-5.2-codex':
      return 'GPT-5.2 Codex'
    case 'gpt-5.1-codex':
      return 'GPT-5.1 Codex'
    case 'gpt-5.1-codex-max':
      return 'GPT-5.1 Codex Max'
    case 'gpt-5.1-codex-mini':
      return 'GPT-5.1 Codex Mini'
    default:
      return null
  }
}
